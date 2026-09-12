// Offline app-shell cache only — never anything playlist-, guide-, or
// stream-related. See the DENY_PATH_RE / DENY_CONTENT_TYPE_RE checks
// below: they're evaluated FIRST, before any cache logic, so a match
// there always goes straight to the network with no caching involved,
// regardless of what the ALLOW list below might otherwise suggest.

const CACHE_VERSION = 'iptv4u-shell-v1';

const SHELL_ASSETS = [
  '/',
  '/watch',
  '/styles.css',
  '/watch.css',
  '/app.js',
  '/watch.js',
  '/watch-core.js',
  '/manifest.webmanifest',
  '/assets/logo.png'
];

// Deny-first: playlists, guides, published-file and API responses, and
// anything under a playback-related path must never be cached or served
// from cache, full stop — these can carry per-project data, and for
// /iptv|/epg specifically the whole point is that they're always fresh.
const DENY_PATH_RE = /^\/(iptv|epg|api|logo)\//;

// Defense in depth beyond the path check above: never cache a response
// whose Content-Type is itself a media/manifest/playlist type, no matter
// what path it came from.
const DENY_CONTENT_TYPE_RE = /^(video\/|audio\/|application\/vnd\.apple\.mpegurl|application\/x-mpegurl|application\/dash\+xml|application\/octet-stream)/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {
        // A single missing/unreachable shell asset shouldn't block
        // install entirely — best-effort precache.
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // never intercept POST /api/*, etc.

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Cross-origin (hls.js/mpegts.js CDN scripts, external logos, TMDB
  // posters, ...) — never handled by this service worker at all.
  if (url.origin !== self.location.origin) return;

  if (DENY_PATH_RE.test(url.pathname)) return; // straight to network, no cache involved

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request).then((response) => {
        const contentType = response.headers.get('content-type') || '';
        if (response.ok && !DENY_CONTENT_TYPE_RE.test(contentType)) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(() => cached || Response.error());

      // Cache-first for the static shell (fast, and works offline);
      // falls through to network for anything not yet cached.
      return cached || networkFetch;
    })
  );
});
