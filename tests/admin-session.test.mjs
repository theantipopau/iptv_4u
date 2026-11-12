import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MINIMAL_M3U, buildGuide } from './fixtures.mjs';
import {
  ADMIN_COOKIE,
  assertAdminAccess,
  checkAdminAccess,
  clearAdminSessionCookie,
  createAdminSession,
  readCookie,
  verifyAdminSession
} from '../shared/admin-session.js';

const IDS = ['example.one', 'example.two'];
const TOKEN = 'test-admin-token-123';

test('a configured token is required, and the header still works for scripts', async () => {
  assert.deepEqual(await checkAdminAccess({ adminToken: TOKEN }), { ok: false, reason: 'missing' });
  assert.deepEqual(await checkAdminAccess({ adminToken: TOKEN, headerToken: 'nope' }), { ok: false, reason: 'invalid-token' });
  assert.deepEqual(await checkAdminAccess({ adminToken: TOKEN, headerToken: TOKEN }), { ok: true, via: 'header' });
});

test('no configured token leaves writes open', async () => {
  assert.deepEqual(await checkAdminAccess({ adminToken: '' }), { ok: true, via: 'unconfigured' });
});

test('a session cookie authorises a request without the token, and expires on its own', async () => {
  const session = await createAdminSession(TOKEN, { now: 1_000, ttlMs: 1_000, secure: true });
  const header = `other=x; ${ADMIN_COOKIE}=${session.value}`;

  assert.deepEqual(await checkAdminAccess({ adminToken: TOKEN, cookieHeader: header, now: 1_500 }), { ok: true, via: 'session' });
  assert.equal((await checkAdminAccess({ adminToken: TOKEN, cookieHeader: header, now: 2_000 })).reason, 'invalid-session');
  assert.match(session.cookie, /HttpOnly/);
  assert.match(session.cookie, /SameSite=Strict/);
  assert.match(session.cookie, /Path=\//);
  assert.match(session.cookie, /Max-Age=1/);
  assert.match(session.cookie, /; Secure/);
});

test('the cookie value is not the token, and cannot be edited or reused after rotation', async () => {
  const session = await createAdminSession(TOKEN);
  assert.notEqual(session.value, TOKEN);
  assert.equal(await verifyAdminSession(TOKEN, session.value), true);

  const [expiry, signature] = session.value.split('.');
  assert.equal(await verifyAdminSession(TOKEN, `${Number(expiry) + 86_400_000}.${signature}`), false, 'a stretched expiry breaks the signature');
  assert.equal(await verifyAdminSession(TOKEN, `${expiry}.${'0'.repeat(signature.length)}`), false, 'a forged signature is refused');
  assert.equal(await verifyAdminSession('rotated-token', session.value), false, 'rotating the secret invalidates every session');
});

test('access failures carry the status and code the UI branches on', async () => {
  await assert.rejects(() => assertAdminAccess({ adminToken: TOKEN }), { code: 'ADMIN_TOKEN_REQUIRED', status: 401 });
  await assert.rejects(() => assertAdminAccess({ adminToken: TOKEN, headerToken: 'x' }), { code: 'ADMIN_TOKEN_INVALID', status: 401 });
  await assert.rejects(() => assertAdminAccess({ adminToken: TOKEN, cookieHeader: `${ADMIN_COOKIE}=1.bad` }), { code: 'ADMIN_SESSION_INVALID', status: 401 });
});

test('signing out expires exactly the cookie the session was minted into', async () => {
  const session = await createAdminSession(TOKEN, { secure: true });
  const cleared = clearAdminSessionCookie({ secure: true }).cookie;

  assert.match(cleared, new RegExp(`^${ADMIN_COOKIE}=;`));
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
  assert.match(cleared, /HttpOnly/);
  assert.match(cleared, /SameSite=Strict/);
  assert.match(cleared, /; Secure/);

  // A browser only removes a cookie whose name and Path both match, so those
  // must agree with the minted one — otherwise sign-out silently does nothing.
  const matchKeys = (cookie) => cookie.split('; ').filter((part) => /^(Path=|HttpOnly$|SameSite=)/.test(part));
  assert.deepEqual(matchKeys(cleared), matchKeys(session.cookie));
});

test('a cleared session no longer authorises anything', async () => {
  const session = await createAdminSession(TOKEN);
  const cleared = clearAdminSessionCookie();
  const emptyValue = readCookie(cleared.cookie.split(';')[0]);

  assert.equal(emptyValue, '');
  assert.equal(await verifyAdminSession(TOKEN, emptyValue), false);
  // And the old cookie is still valid on its own — signing out is a browser-side
  // instruction, which is why the route must send it rather than just 200ing.
  assert.equal(await verifyAdminSession(TOKEN, session.value), true);
});

test('readCookie picks the right entry out of a real header', () => {
  assert.equal(readCookie(`a=1; ${ADMIN_COOKIE}=abc; b=2`), 'abc');
  assert.equal(readCookie(`not_${ADMIN_COOKIE}=abc`), '');
  assert.equal(readCookie(''), '');
  assert.equal(readCookie(undefined), '');
});

describe('the admin session route', () => {
  let server;
  let baseUrl;
  const dirs = [];

  before(async () => {
    process.env.IPTV4U_LOG_SILENT = '1';
    process.env.IPTV4U_NO_LISTEN = '1';
    process.env.ADMIN_TOKEN = 'route-admin-token';
    for (const prefix of ['iptv4u-admin-session-', 'iptv4u-admin-session-cache-']) {
      dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    }
    process.env.IPTV4U_HOSTED_DIR = dirs[0];
    process.env.IPTV4U_CACHE_DIR = dirs[1];
    const { app } = await import('../server.js');
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server?.closeAllConnections?.();
    server?.close();
    for (const dir of dirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function publishRequest(headers = {}) {
    return fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        slug: 'secured',
        m3uContent: MINIMAL_M3U,
        xmlContent: buildGuide({ ids: IDS, programmesPerChannel: 48 })
      })
    });
  }

  async function login(token = 'route-admin-token') {
    const response = await fetch(`${baseUrl}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    return { response, json: await response.json() };
  }

  test('a write with no credentials is refused and names the missing token', async () => {
    const response = await publishRequest();
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'ADMIN_TOKEN_REQUIRED');
  });

  test('the wrong token does not mint a cookie', async () => {
    const { response, json } = await login('wrong');
    assert.equal(response.status, 401);
    assert.equal(json.code, 'ADMIN_TOKEN_INVALID');
    assert.equal(response.headers.get('set-cookie'), null);
  });

  test('a valid token returns an HttpOnly strict cookie that authorises writes', async () => {
    const { response, json } = await login();
    assert.equal(response.status, 200);
    assert.equal(json.configured, true);

    const setCookie = response.headers.get('set-cookie') || '';
    assert.match(setCookie, new RegExp(`^${ADMIN_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.equal(/Secure/.test(setCookie), false, 'the test server is plain http');

    const publish = await publishRequest({ Cookie: setCookie.split(';')[0] });
    assert.equal(publish.status, 200);
    assert.equal((await publish.json()).ok, true);
  });

  test('the X-Admin-Token header still works for curl and scripts', async () => {
    const publish = await publishRequest({ 'X-Admin-Token': 'route-admin-token' });
    assert.equal(publish.status, 200);
  });

  test('session status reports whether this browser is signed in, uncached', async () => {
    const anonymous = await fetch(`${baseUrl}/api/admin/session`);
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await anonymous.json(), { ok: true, configured: true, signedIn: false });

    const { response } = await login();
    const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
    const signedIn = await fetch(`${baseUrl}/api/admin/session`, { headers: { Cookie: cookie } });
    assert.deepEqual(await signedIn.json(), { ok: true, configured: true, signedIn: true });
  });

  test('signing out sends the Set-Cookie that clears the HttpOnly cookie', async () => {
    const { response } = await login();
    const cookie = (response.headers.get('set-cookie') || '').split(';')[0];

    const out = await fetch(`${baseUrl}/api/admin/session`, {
      method: 'DELETE',
      headers: { Cookie: cookie }
    });
    assert.equal(out.status, 200);
    assert.equal(out.headers.get('cache-control'), 'no-store');

    const setCookie = out.headers.get('set-cookie') || '';
    assert.match(setCookie, new RegExp(`^${ADMIN_COOKIE}=;`));
    assert.match(setCookie, /Max-Age=0/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);

    // The route must work with no credentials at all: an expired session is the
    // case where someone most needs to clear it.
    const anonymous = await fetch(`${baseUrl}/api/admin/session`, { method: 'DELETE' });
    assert.equal(anonymous.status, 200);
    assert.match(anonymous.headers.get('set-cookie') || '', new RegExp(`^${ADMIN_COOKIE}=;`));
  });

  test('a tampered cookie is refused, not silently upgraded', async () => {
    const { response } = await login();
    const [name, value] = (response.headers.get('set-cookie') || '').split(';')[0].split('=');
    const [expiry, signature] = value.split('.');
    const tampered = `${name}=${Number(expiry) + 86_400_000}.${signature}`;

    const publish = await publishRequest({ Cookie: tampered });
    assert.equal(publish.status, 401);
    assert.equal((await publish.json()).code, 'ADMIN_SESSION_INVALID');
  });
});
