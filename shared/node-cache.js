// Node filesystem cache adapter — implements the async {get, getStale, set}
// interface that shared/epg-service.js expects. Used by server.js for local
// / self-hosted deployments. See shared/kv-cache.js for the Cloudflare KV
// equivalent. The two must stay behaviourally identical (including the
// `set(name, data, { strict, ttlSeconds })` options) or local and Cloudflare
// publishing diverge in ways that only show up in production.

import fs from 'fs';
import path from 'path';

export function createNodeCache(dir) {
  // cache keys can contain ':' (e.g. "source:example.com") — safe as a
  // filename on Windows/POSIX once swapped for a filesystem-safe char.
  const mangle = (name) => String(name).replace(/[:/\\]/g, '_');
  function filePath(name) {
    return path.join(dir, `${mangle(name)}.json`);
  }

  /**
   * Value plus the envelope's write time (see the KV adapter's getEntry for
   * why: a publication written before manifests existed has no recorded
   * publishedAt, and this is the closest honest equivalent).
   * @param {string} name
   */
  async function getEntry(name) {
    try {
      const raw = fs.readFileSync(filePath(name), 'utf8');
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

  async function set(name, data, callOptions = {}) {
    // ttlSeconds is accepted for interface parity with the KV adapter (and
    // because published files are written with "no expiry"): on disk there is
    // nothing to expire, so the only meaningful option here is `strict`.
    const target = filePath(name);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Write-then-rename: a crash or a concurrent writer can't leave a
      // half-written file behind for a reader to serve as content.
      fs.writeFileSync(temp, JSON.stringify({ updatedAt: Date.now(), data }));
      fs.renameSync(temp, target);
      return { stored: true };
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch { /* nothing to clean up */ }
      if (callOptions.strict) {
        error.code = error.code || 'STORAGE_WRITE_FAILED';
        error.status = error.status || 503;
        throw error;
      }
      // best-effort cache; ignore write failures (e.g. read-only fs)
      return { stored: false };
    }
  }

  /**
   * Every stored entry whose key starts with `prefix`, as `{name, data}` —
   * filesystem parity with the KV adapter's list().
   *
   * The only characters the filename mangle replaces are `:`, `/` and `\`,
   * and every key this app writes is `<prefix>:<rest>` where `<rest>` is a
   * slug (`[a-z0-9-]+`) or a slug + `:version:kind`. That makes the reverse
   * mapping unambiguous: the mangled remainder can be turned back into `:`
   * separators exactly.
   * @param {string} prefix
   */
  async function list(prefix) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      return []; // nothing stored yet
    }
    const mangledPrefix = mangle(prefix);
    const found = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const base = file.slice(0, -'.json'.length);
      if (!base.startsWith(mangledPrefix)) continue;
      const name = prefix + base.slice(mangledPrefix.length).replace(/_/g, ':');
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        found.push({ name, data: parsed.data });
      } catch {
        // skip an unreadable/corrupt file rather than failing the whole listing
      }
    }
    return found;
  }

  return { get, getStale, getEntry, set, list };
}
