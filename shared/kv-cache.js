// Cloudflare KV cache adapter — implements the async {get, getStale, set}
// interface that shared/epg-service.js expects. See shared/node-cache.js
// for the local-Node equivalent.
//
// KV's own TTL isn't used for the *EPG source cache*'s expiry: we want
// "stale-if-error" (serve expired data when a live fetch fails) rather than
// deletion, so every entry is stored as { updatedAt, data } and freshness is
// checked manually, exactly like the Node disk cache. The TTL that IS set
// there is only a long backstop so abandoned entries eventually go away.
//
// Published files (the hosted M3U/XML a player fetches) are a different
// contract entirely: they must never expire on their own, because the URL is
// what TiViMate is pointed at. That's why `ttlSeconds: null` exists — see
// createHostedKvStore below.
//
// Write failures are NOT swallowed: a cache write is best-effort, but a
// publication write isn't (see the `strict` option on set), and silently
// succeeding is exactly how you end up with "published" content that was
// never stored.

const DEFAULT_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * @param {KVNamespace} kv
 * @param {{ttlSeconds?: number|null}} [options] `ttlSeconds: null` stores values with no expiry.
 */
export function createKvCache(kv, options = {}) {
  const ttlSeconds = options.ttlSeconds === undefined ? DEFAULT_CACHE_TTL_SECONDS : options.ttlSeconds;

  function requireBinding() {
    if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
      const error = new Error('The KV binding for this store is missing or misconfigured (check wrangler.toml / the Worker bindings).');
      error.status = 503;
      error.code = 'STORAGE_BINDING_MISSING';
      throw error;
    }
  }

  async function readRaw(name) {
    requireBinding();
    return kv.get(name);
  }

  /**
   * Value plus the envelope's own write time. Content published before
   * manifests existed has no recorded `publishedAt`, and the envelope's
   * `updatedAt` is the closest honest equivalent — it is set whenever the
   * value is written, which for a publication key is when it was published.
   * @param {string} name
   * @returns {Promise<{data: any, updatedAt: number|null}|null>}
   */
  async function getEntry(name) {
    const raw = await readRaw(name);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return { data: parsed.data, updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null };
    } catch {
      return null;
    }
  }

  async function getStale(name) {
    const entry = await getEntry(name);
    return entry ? entry.data : null;
  }

  async function get(name, maxAgeMs) {
    const entry = await getEntry(name);
    if (!entry) return null;
    if (entry.updatedAt === null || Date.now() - entry.updatedAt > maxAgeMs) return null;
    return entry.data;
  }

  /**
   * Every stored entry whose key starts with `prefix`, as `{name, data}`.
   * Used to enumerate what is actually in the store (every published slug,
   * every saved auto-refresh config) instead of trusting an index that can
   * drift out of sync. KV paginates, so this follows the cursor.
   * @param {string} prefix
   * @returns {Promise<{name: string, data: any}[]>}
   */
  async function list(prefix) {
    requireBinding();
    if (typeof kv.list !== 'function') {
      const error = new Error('The KV binding for this store does not support list() (check the binding in wrangler.toml).');
      error.status = 503;
      error.code = 'STORAGE_BINDING_MISSING';
      throw error;
    }
    const found = [];
    let cursor;
    do {
      const page = await kv.list({ prefix, cursor });
      for (const entry of page.keys || []) {
        const raw = await kv.get(entry.name);
        if (!raw) continue;
        try {
          found.push({ name: entry.name, data: JSON.parse(raw).data });
        } catch {
          // An unparseable entry is reported as absent rather than crashing
          // the whole listing — one bad key must not hide every good one.
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return found;
  }

  async function set(name, data, callOptions = {}) {
    const effectiveTtl = callOptions.ttlSeconds === undefined ? ttlSeconds : callOptions.ttlSeconds;
    const putOptions = {};
    // A null/0 TTL means "keep forever" — a published playlist/guide must not
    // disappear 30 days after it was written. (This was a real bug: published
    // files inherited the cache's 30-day TTL and silently 404'd after it.)
    if (effectiveTtl) putOptions.expirationTtl = effectiveTtl;
    // A missing binding is a deployment misconfiguration, not a transient
    // write failure: it must surface even for a best-effort cache write,
    // otherwise the app quietly stops caching anything and looks healthy.
    requireBinding();
    try {
      await kv.put(name, JSON.stringify({ updatedAt: Date.now(), data }), putOptions);
      return { stored: true };
    } catch (error) {
      if (callOptions.strict) {
        error.code = error.code || 'STORAGE_WRITE_FAILED';
        error.status = error.status || 503;
        throw error;
      }
      // best-effort cache; ignore write failures
      return { stored: false };
    }
  }

  return { get, getStale, getEntry, set, list };
}

/**
 * Store for published files (playlist/guide/manifest/overrides/logo assets):
 * never expires, and writes are expected to be confirmed by the caller.
 * @param {KVNamespace} kv
 */
export function createHostedKvStore(kv) {
  return createKvCache(kv, { ttlSeconds: null });
}
