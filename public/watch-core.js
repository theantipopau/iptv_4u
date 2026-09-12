// Pure, DOM-free logic for the /watch viewer — no `document`, `window`,
// `localStorage`, or any other browser-only global may be referenced here.
// This is what makes it importable both by public/watch.js (in the
// browser) and by tests/*.test.mjs (under plain Node, via `node --test`)
// without a DOM shim or a bundler.

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(value) {
  return String(value || '').replace(/&(amp|lt|gt|quot|apos|#(\d+));/g, (m, name, code) => {
    if (code) return String.fromCharCode(Number(code));
    return XML_ENTITIES[name] || m;
  });
}

// Mirrors shared/core.js's parseM3U closely enough for display/playback
// purposes — this page only ever reads an already-published playlist, it
// never needs to round-trip or re-serialize it.
export function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const match of line.matchAll(/([\w-]+)="([^"]*)"/g)) {
        attrs[match[1]] = match[2];
      }
      const commaIdx = line.indexOf(',');
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : `Channel ${channels.length + 1}`;
      pending = { index: channels.length, name, attrs, url: '' };
      continue;
    }

    if (pending && !line.startsWith('#')) {
      pending.url = line;
      channels.push(pending);
      pending = null;
    }
  }

  if (pending) channels.push(pending);
  return channels;
}

// A stable identity for favourites/recents that survives a re-publish
// changing the channel order — prefer the EPG id, fall back to the name.
export function channelKey(channel) {
  return channel.attrs['tvg-id'] || channel.name;
}

// XMLTV timestamps look like "20260912040000 +0700" — a fixed-width
// date/time plus an optional UTC offset (no offset means UTC). Correctly
// honouring the offset (not just stripping it) is what makes this behave
// right across timezones and DST — a "+1000" (AEST, no DST) or "+1100"
// (AEDT) offset is exactly what's in the string, so there's no separate
// DST calculation needed here; the guide source already resolved it.
export function parseXmltvDate(str) {
  if (!str) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/.exec(String(str).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : 'Z'}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// A compact now/next index, keyed by XMLTV channel id. Deliberately a
// small hand-written parser (same style as parseM3U above) rather than
// DOMParser — DOMParser doesn't exist under plain Node, and this way the
// exact same function that runs in the browser is what gets tested.
// synthesize/applyIdentity (shared/epg-service.js) tags every placeholder
// 24/7 programme it generates with <category>24/7</category> — that's
// the one and only marker distinguishing a synthesized guess from a real
// schedule, so it's carried through as `isPlaceholder` here rather than
// silently presenting a placeholder as verified programming.
export function parseGuideForNowNext(xmlText) {
  const guide = new Map();
  if (!xmlText) return guide;

  const programmeRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let match;
  while ((match = programmeRe.exec(xmlText))) {
    const attrsStr = match[1];
    const body = match[2];
    const channelId = /\bchannel="([^"]*)"/.exec(attrsStr)?.[1];
    const start = parseXmltvDate(/\bstart="([^"]*)"/.exec(attrsStr)?.[1]);
    if (!channelId || !start) continue;
    const stop = parseXmltvDate(/\bstop="([^"]*)"/.exec(attrsStr)?.[1]);
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(body);
    const title = titleMatch ? decodeXmlEntities(titleMatch[1]).trim() : '';
    const isPlaceholder = /<category\b[^>]*>\s*24\/7\s*<\/category>/.test(body);

    if (!guide.has(channelId)) guide.set(channelId, []);
    guide.get(channelId).push({ start, stop, title, isPlaceholder });
  }

  for (const list of guide.values()) list.sort((a, b) => a.start - b.start);
  return guide;
}

// Missing stop times are handled the same way core.js's server-side
// guide merge does — the next programme's start becomes the effective
// stop, and only the last item in the list is genuinely open-ended.
export function getNowNext(guide, channelId, now = new Date()) {
  const list = guide.get(channelId);
  if (!list || !list.length) return { current: null, next: null };

  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    if (p.start > now) return { current: null, next: p };
    const effectiveStop = p.stop || (list[i + 1] ? list[i + 1].start : null);
    if (!effectiveStop || now < effectiveStop) {
      return { current: p, next: list[i + 1] || null };
    }
  }
  return { current: null, next: null };
}

// Up to `count` programmes starting from (and including) whichever one is
// current, for the "several upcoming entries" mini-guide panel.
export function getUpcoming(guide, channelId, now = new Date(), count = 5) {
  const list = guide.get(channelId);
  if (!list || !list.length) return [];
  let startIdx = list.findIndex((p) => {
    const effectiveStop = p.stop || null;
    return !effectiveStop || now < effectiveStop;
  });
  if (startIdx === -1) startIdx = list.length - 1;
  return list.slice(startIdx, startIdx + count);
}

// --- favourites / recents (pure list operations; storage I/O stays in watch.js) ---

export function pushRecent(recents, key, max = 12) {
  return [key, ...recents.filter((k) => k !== key)].slice(0, max);
}

// A republish can drop channels entirely (renumbered lineup, provider
// removed one, ...) — stored favourite/recent keys for those are just
// quietly dropped rather than left to reference nothing.
export function pruneStaleKeys(keys, validKeySet) {
  return keys.filter((k) => validKeySet.has(k));
}

// --- HTTPS-upgrade + mixed content ---

export function isMixedContentCandidate(pageProtocol, streamUrl) {
  return pageProtocol === 'https:' && /^http:\/\//i.test(streamUrl || '');
}

// Pure string transform — never mutates or persists over the original
// URL; the caller decides whether/when to use the result, and the
// channel's own stored url is never reassigned.
export function buildHttpsUpgradeUrl(streamUrl) {
  if (!/^http:\/\//i.test(streamUrl || '')) return null;
  return streamUrl.replace(/^http:\/\//i, 'https://');
}

// --- redaction (used by diagnostics export and anywhere a URL might be logged/shown) ---

// Keeps scheme + host + path (useful for a human to recognize "yes, this
// is the right channel"), drops query string, userinfo, hash — where
// tokens/keys/session ids actually live for most IPTV providers.
export function redactUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    // Not a parseable absolute URL — still strip anything after the
    // first '?' or '#' so a malformed value can't leak a query string.
    return String(rawUrl).split(/[?#]/)[0];
  }
}

export function redactHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
}

// --- stream type classification ---

// Content-Type is authoritative when a same-origin/CORS-permitted fetch
// could read it; the URL extension is only ever a secondary hint (some
// IPTV panels serve HLS through extensionless paths, or serve MPEG-TS
// through a path that happens to end in .m3u8 — this project has seen
// both in the wild).
export function classifyStreamType(url, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct) {
    if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) return 'hls';
    if (ct.includes('dash+xml')) return 'dash';
    if (ct.includes('mp2t')) return 'mpegts';
    if (ct.includes('mp4')) return 'mp4';
    if (ct.includes('webm')) return 'webm';
    if (ct.startsWith('text/html') || ct.startsWith('application/json') || ct.startsWith('text/plain')) return 'not-media';
  }
  const u = (url || '').split(/[?#]/)[0].toLowerCase();
  if (/\.m3u8?$/.test(u)) return 'hls';
  if (/\.mpd$/.test(u)) return 'dash';
  if (/\.ts$/.test(u)) return 'mpegts';
  if (/\.mp4$/.test(u)) return 'mp4';
  if (/\.webm$/.test(u)) return 'webm';
  return 'unknown';
}

// --- error classification (named categories, plain-language message) ---

export const ERROR_MESSAGES = {
  HTTP_MIXED_CONTENT: 'This channel uses an insecure HTTP stream that the browser cannot load from this HTTPS page.',
  HTTPS_UPGRADE_FAILED: 'IPTV 4U tried the secure version of this stream, but the provider did not make it available over HTTPS.',
  CORS_BLOCKED: 'The stream server does not allow this browser to access the channel directly.',
  MANIFEST_LOAD_FAILED: 'The channel guide loaded, but its video playlist could not be retrieved.',
  MANIFEST_PARSE_FAILED: 'The channel returned a playlist format that could not be read.',
  MEDIA_NETWORK_ERROR: 'The video connection was interrupted.',
  MEDIA_DECODE_ERROR: "The stream reached the browser, but its video or audio format could not be decoded.",
  AUTH_EXPIRED: "The provider rejected this stream. Its access address may have expired.",
  LOAD_TIMEOUT: 'The channel did not begin loading within the expected period.',
  AUTOPLAY_BLOCKED: 'Tap Play to start this channel.',
  UNSUPPORTED_FORMAT: 'This channel uses a format that this browser cannot play directly.',
  UNKNOWN: 'This channel could not be played directly in the browser.'
};

// hls.js's `details` codes and mpegts.js's error types are the only
// evidence available client-side — mapped to the named categories above
// rather than invented ones, so "every failure is CORS" doesn't happen.
const HLS_DETAIL_CATEGORY = {
  manifestLoadError: 'MANIFEST_LOAD_FAILED',
  manifestLoadTimeOut: 'LOAD_TIMEOUT',
  manifestParsingError: 'MANIFEST_PARSE_FAILED',
  levelLoadError: 'MANIFEST_LOAD_FAILED',
  levelLoadTimeOut: 'LOAD_TIMEOUT',
  fragLoadError: 'MEDIA_NETWORK_ERROR',
  fragLoadTimeOut: 'LOAD_TIMEOUT',
  bufferAddCodecError: 'MEDIA_DECODE_ERROR',
  bufferIncompatibleCodecsError: 'MEDIA_DECODE_ERROR',
  keyLoadError: 'MEDIA_DECODE_ERROR',
  keySystemNoKeys: 'MEDIA_DECODE_ERROR'
};

const MPEGTS_TYPE_CATEGORY = {
  NetworkError: 'MEDIA_NETWORK_ERROR',
  MediaError: 'MEDIA_DECODE_ERROR'
};

// `source` is which player produced the failure; `detail` is that
// player's own error code/type; `httpStatus`, when known from a same-
// origin-permitted fetch, refines network failures into AUTH_EXPIRED
// (401/403/410) vs a generic network failure.
export function classifyPlaybackError({ source, detail, httpStatus, isUpgradeAttempt } = {}) {
  if (isUpgradeAttempt) {
    return { category: 'HTTPS_UPGRADE_FAILED', message: ERROR_MESSAGES.HTTPS_UPGRADE_FAILED };
  }
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 410) {
    return { category: 'AUTH_EXPIRED', message: ERROR_MESSAGES.AUTH_EXPIRED };
  }
  if (source === 'watchdog') {
    return { category: 'LOAD_TIMEOUT', message: ERROR_MESSAGES.LOAD_TIMEOUT };
  }
  if (source === 'hls') {
    const category = HLS_DETAIL_CATEGORY[detail] || 'UNKNOWN';
    return { category, message: ERROR_MESSAGES[category] };
  }
  if (source === 'mpegts') {
    const category = MPEGTS_TYPE_CATEGORY[detail] || 'UNKNOWN';
    return { category, message: ERROR_MESSAGES[category] };
  }
  if (source === 'native') {
    // HTMLMediaElement.error.code: 1 ABORTED, 2 NETWORK, 3 DECODE, 4 SRC_NOT_SUPPORTED
    if (detail === 2) return { category: 'MEDIA_NETWORK_ERROR', message: ERROR_MESSAGES.MEDIA_NETWORK_ERROR };
    if (detail === 3 || detail === 4) return { category: 'MEDIA_DECODE_ERROR', message: ERROR_MESSAGES.MEDIA_DECODE_ERROR };
    return { category: 'UNKNOWN', message: ERROR_MESSAGES.UNKNOWN };
  }
  if (source === 'autoplay') {
    return { category: 'AUTOPLAY_BLOCKED', message: ERROR_MESSAGES.AUTOPLAY_BLOCKED };
  }
  if (source === 'unsupported-format') {
    return { category: 'UNSUPPORTED_FORMAT', message: ERROR_MESSAGES.UNSUPPORTED_FORMAT };
  }
  return { category: 'UNKNOWN', message: ERROR_MESSAGES.UNKNOWN };
}

export function formatTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
