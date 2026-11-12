// HttpOnly admin sessions.
//
// The admin token used to live in localStorage, where any script running on the
// origin — including a compromised dependency — could read it and exfiltrate it
// with the same origin's own `fetch`. The browser now exchanges it once for an
// HttpOnly cookie: page JavaScript can neither read nor forge that cookie, and
// rotating ADMIN_TOKEN invalidates every session at once, because the token is
// the HMAC key.
//
// The cookie value is deliberately not the token. It is
// `<expiresAt>.<hex HMAC>` signed with the token as the key, so a stolen cookie
// can't be replayed as an `X-Admin-Token` header and expires on its own. The
// header stays supported for curl/scripts, where there is no page to protect.

export const ADMIN_COOKIE = 'iptv4u_admin_session';
export const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const SIGNING_CONTEXT = 'iptv4u-admin-session:v1:';

function toHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

// Length-checked, constant-time-ish comparison. The difference is not a
// practical oracle over a network, but it costs nothing to avoid the obvious one.
function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function sign(secret, expiresAt) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${SIGNING_CONTEXT}${expiresAt}`));
  return toHex(new Uint8Array(signature));
}

// A browser only overwrites/removes a cookie when the name AND Path match, so
// minting and clearing must come from this one builder rather than each spelling
// out its own attributes.
function cookieAttributes({ secure, maxAge }) {
  const attributes = [
    'Path=/',
    'HttpOnly',
    // Never sent on a cross-site request, which — together with the JSON
    // content type every write uses — is the CSRF defence.
    'SameSite=Strict',
    `Max-Age=${maxAge}`
  ];
  // Conditional so local http://localhost development still stores the cookie;
  // both runtimes are https in production.
  if (secure) attributes.push('Secure');
  return attributes;
}

/**
 * Mint a session cookie for an already-verified admin token.
 * @param {string} adminToken
 * @param {{now?: number, ttlMs?: number, secure?: boolean}} [options]
 * @returns {Promise<{value: string, expiresAt: number, maxAge: number, cookie: string}>}
 */
export async function createAdminSession(adminToken, { now = Date.now(), ttlMs = ADMIN_SESSION_TTL_MS, secure = false } = {}) {
  if (!adminToken) throw new Error('Cannot create an admin session without a configured token.');
  const expiresAt = now + ttlMs;
  const value = `${expiresAt}.${await sign(adminToken, expiresAt)}`;
  const maxAge = Math.floor(ttlMs / 1000);
  const cookie = [
    `${ADMIN_COOKIE}=${value}`,
    ...cookieAttributes({ secure, maxAge })
  ].join('; ');
  return { value, expiresAt, maxAge, cookie };
}

/**
 * Expire the session cookie in the browser. An HttpOnly cookie cannot be
 * cleared from page JavaScript, so signing out is a request the server answers
 * with this Set-Cookie. It needs no credentials: clearing your own cookie is
 * always allowed, and requiring a live session would make sign-out fail
 * exactly when the session has already expired.
 * @param {{secure?: boolean}} [options]
 * @returns {{cookie: string}}
 */
export function clearAdminSessionCookie({ secure = false } = {}) {
  return {
    cookie: [
      `${ADMIN_COOKIE}=`,
      ...cookieAttributes({ secure, maxAge: 0 }),
      // Max-Age is authoritative for modern browsers; Expires is the same
      // instruction for anything that only understands the older one.
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    ].join('; ')
  };
}

/**
 * Read one cookie by name from a raw Cookie header.
 * @param {string|null|undefined} cookieHeader
 * @param {string} [name]
 * @returns {string} the value, or '' when absent
 */
export function readCookie(cookieHeader, name = ADMIN_COOKIE) {
  if (!cookieHeader) return '';
  for (const part of String(cookieHeader).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

/**
 * Verify a session value against the current token. Expiry is inside the signed
 * payload, so neither it nor the signature can be edited without invalidating it.
 * @param {string} adminToken
 * @param {string} value the cookie value (not the whole Cookie header)
 * @param {{now?: number}} [options]
 * @returns {Promise<boolean>}
 */
export async function verifyAdminSession(adminToken, value, { now = Date.now() } = {}) {
  if (!adminToken || typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  if (dot < 1) return false;
  const expiryText = value.slice(0, dot);
  if (!/^\d{1,16}$/.test(expiryText)) return false;
  const expiresAt = Number(expiryText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  return constantTimeEqual(value.slice(dot + 1), await sign(adminToken, expiresAt));
}

/**
 * Decide whether a request may perform an admin action.
 * Header first (for scripts), then the HttpOnly session cookie.
 * @param {{headerToken?: string|null, cookieHeader?: string|null, adminToken?: string, now?: number}} options
 * @returns {Promise<{ok: boolean, via?: 'header'|'session'|'unconfigured', reason?: 'missing'|'invalid-token'|'invalid-session'}>}
 */
export async function checkAdminAccess({ headerToken, cookieHeader, adminToken, now = Date.now() }) {
  // No secret configured: writes stay open, exactly as before.
  if (!adminToken) return { ok: true, via: 'unconfigured' };

  if (typeof headerToken === 'string' && headerToken) {
    return constantTimeEqual(headerToken, adminToken)
      ? { ok: true, via: 'header' }
      : { ok: false, reason: 'invalid-token' };
  }

  const value = readCookie(cookieHeader);
  if (!value) return { ok: false, reason: 'missing' };
  return (await verifyAdminSession(adminToken, value, { now }))
    ? { ok: true, via: 'session' }
    : { ok: false, reason: 'invalid-session' };
}

/**
 * Throwing form of checkAdminAccess, shared by both runtimes so the status and
 * machine-readable code are identical.
 * @param {{headerToken?: string|null, cookieHeader?: string|null, adminToken?: string, now?: number}} options
 * @returns {Promise<{ok: boolean, via?: string}>}
 */
export async function assertAdminAccess(options) {
  const result = await checkAdminAccess(options);
  if (result.ok) return result;
  const messages = {
    'invalid-token': 'The admin token is wrong.',
    'invalid-session': 'The admin session has expired — enter the admin token again.',
    missing: 'This action needs the admin token.'
  };
  const codes = {
    'invalid-token': 'ADMIN_TOKEN_INVALID',
    'invalid-session': 'ADMIN_SESSION_INVALID',
    missing: 'ADMIN_TOKEN_REQUIRED'
  };
  const error = new Error(messages[result.reason]);
  error.status = 401;
  error.code = codes[result.reason];
  throw error;
}
