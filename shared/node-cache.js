// Node filesystem cache adapter — implements the async {get, getStale, set}
// interface that shared/epg-service.js expects. Used by server.js for local
// / self-hosted deployments. See functions/_lib/kv-cache.js for the
// Cloudflare KV equivalent.

import fs from 'fs';
import path from 'path';

export function createNodeCache(dir) {
  function filePath(name) {
    // cache keys can contain ':' (e.g. "source:example.com") — safe as a
    // filename on Windows/POSIX once swapped for a filesystem-safe char.
    return path.join(dir, `${name.replace(/[:/\\]/g, '_')}.json`);
  }

  async function getStale(name) {
    try {
      const raw = fs.readFileSync(filePath(name), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed.data;
    } catch {
      return null;
    }
  }

  async function get(name, maxAgeMs) {
    try {
      const raw = fs.readFileSync(filePath(name), 'utf8');
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.updatedAt > maxAgeMs) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  async function set(name, data) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath(name), JSON.stringify({ updatedAt: Date.now(), data }));
    } catch {
      // best-effort cache; ignore write failures (e.g. read-only fs)
    }
  }

  return { get, getStale, set };
}
