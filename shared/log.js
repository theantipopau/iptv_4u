// Structured, redacting logging shared by server.js (Express/Node) and
// worker.js (Cloudflare). One event per stage of the pipeline, always a
// single JSON line, never a stream URL, provider credential or playlist
// body — see SENSITIVE_KEY_RE / redactUrlLike below.
//
// Event names are the pipeline's actual stages, so a production log can be
// read as a timeline: epg.source.fetch.failed, epg.validation.failed,
// publish.storage.readback.failed, hosted.epg.last_known_good_served, ...

const SENSITIVE_KEY_RE = /(url|uri|token|password|passwd|secret|apikey|api_key|username|user|auth|cookie|m3u|xml(?:content)?|content|body|playlist)/i;

// Matches any URL in free text (error messages from fetch often include the
// full request URL, which for an IPTV provider carries credentials).
const URL_IN_TEXT_RE = /\b(https?:\/\/)([^/\s"'<>]+)(\/[^\s"'<>]*)?/gi;

/**
 * Replace any URL in a string with scheme://host/<redacted>.
 * @param {string} text
 */
export function redactUrlLike(text) {
  return String(text || '').replace(URL_IN_TEXT_RE, (_match, scheme, host) => `${scheme}${host}/<redacted>`);
}

const MAX_FIELD_LENGTH = 300;

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactUrlLike(value).slice(0, MAX_FIELD_LENGTH);
  if (depth >= 2) return '[object]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') return '[object]';
  return String(value);
}

/**
 * Drop or sanitize any field that could leak provider credentials.
 * @param {Record<string, unknown>} fields
 */
export function redactFields(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    out[key] = sanitizeValue(value);
  }
  return out;
}

/**
 * Emit one structured log line.
 * @param {string} event e.g. 'publish.completed'
 * @param {Record<string, unknown>} [fields] safe metadata only
 * @param {'info'|'warn'|'error'} [level]
 */
function loggingDisabled() {
  if (globalThis.__IPTV4U_SILENT_LOGS__) return true;
  return typeof process !== 'undefined' && process.env && process.env.IPTV4U_LOG_SILENT === '1';
}

export function logEvent(event, fields = {}, level = 'info') {
  const line = { level, event, at: new Date().toISOString(), ...redactFields(fields) };
  if (loggingDisabled()) return line;
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
  return line;
}

/**
 * Wrap an async stage so its duration and failure are logged consistently.
 * @template T
 * @param {string} event
 * @param {Record<string, unknown>} fields
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function logStage(event, fields, fn) {
  const started = Date.now();
  logEvent(`${event}.started`, fields);
  try {
    const result = await fn();
    logEvent(`${event}.completed`, { ...fields, elapsedMs: Date.now() - started });
    return result;
  } catch (error) {
    logEvent(`${event}.failed`, { ...fields, elapsedMs: Date.now() - started, errorCode: error.code || null, error: error.message }, 'error');
    throw error;
  }
}
