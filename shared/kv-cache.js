// Cloudflare KV cache adapter — implements the async {get, getStale, set}
// interface that shared/epg-service.js expects. See shared/node-cache.js
// for the local-Node equivalent.
//
// KV's own TTL isn't used for expiry: we want "stale-if-error" (serve
// expired data when a live fetch fails) rather than deletion, so every
// entry is stored as { updatedAt, data } and freshness is checked
// manually, exactly like the Node disk cache.

export function createKvCache(kv) {
  async function getStale(name) {
    const raw = await kv.get(name);
    if (!raw) return null;
    try {
      return JSON.parse(raw).data;
    } catch {
      return null;
    }
  }

  async function get(name, maxAgeMs) {
    const raw = await kv.get(name);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.updatedAt > maxAgeMs) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  async function set(name, data) {
    try {
      // Keep entries around for 30 days so a stale-fallback read still has
      // something to serve well after the freshness window has passed.
      await kv.put(name, JSON.stringify({ updatedAt: Date.now(), data }), {
        expirationTtl: 30 * 24 * 60 * 60
      });
    } catch {
      // best-effort cache; ignore write failures
    }
  }

  return { get, getStale, set };
}
