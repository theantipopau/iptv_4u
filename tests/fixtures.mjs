// Shared synthetic fixtures for the test suite. Everything here is invented
// — no real provider playlist, no real stream URL, no credential — so tests
// stay committed safely (see the security notes in README.md).

/** A minimal but structurally valid playlist with two identified channels. */
export const MINIMAL_M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="example.one" tvg-name="Example One" group-title="Test",Example One',
  'http://example.invalid/one.m3u8',
  '#EXTINF:-1 tvg-id="example.two" tvg-name="Example Two" group-title="Test",Example Two',
  'http://example.invalid/two.m3u8',
  ''
].join('\n');

/** A playlist whose channels carry no tvg-id at all. */
export const PLAYLIST_WITHOUT_IDS = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-name="Example One",Example One',
  'http://example.invalid/one.m3u8',
  ''
].join('\n');

export function xmltvStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

/**
 * Build an XMLTV document.
 * @param {{ids: string[], now?: number, programmesPerChannel?: number, hoursAhead?: number, expired?: boolean, offset?: string}} input
 *   `expired: true` puts every programme in the past; `hoursAhead` shifts the
 *   whole schedule forward so a guide can be tested for "ending soon".
 */
export function buildGuide({
  ids,
  now = Date.now(),
  programmesPerChannel = 2,
  hoursAhead = 0,
  expired = false,
  offset = '+0000'
}) {
  const startOfHour = Math.floor(now / 3600000) * 3600000;
  const base = expired ? startOfHour - 48 * 3600000 : startOfHour + hoursAhead * 3600000;
  const channels = ids
    .map((id) => `  <channel id="${id}">\n    <display-name>${id}</display-name>\n  </channel>`)
    .join('\n');
  const programmes = [];
  for (const id of ids) {
    for (let i = 0; i < programmesPerChannel; i += 1) {
      const start = base + i * 3600000;
      const stop = start + 3600000;
      programmes.push(
        `  <programme start="${xmltvStamp(start).replace(' +0000', ` ${offset}`)}" stop="${xmltvStamp(stop).replace(' +0000', ` ${offset}`)}" channel="${id}">\n` +
          `    <title lang="en">Programme ${i + 1}</title>\n` +
          `  </programme>`
      );
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="iptv-4u">\n${channels}\n${programmes.join('\n')}\n</tv>\n`;
}

/** A guide with channels but no programmes at all (logo-only publication). */
export function buildChannelOnlyGuide(ids) {
  const channels = ids.map((id) => `  <channel id="${id}">\n    <display-name>${id}</display-name>\n  </channel>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="iptv-4u">\n${channels}\n</tv>\n`;
}

/**
 * In-memory store adapter with the same shape as createNodeCache/kv-cache,
 * plus hooks so tests can simulate storage failures and corrupted write
 * round-trips that would otherwise need a real KV namespace.
 */
export function memoryStore(seed = {}) {
  const entries = new Map(Object.entries(seed).map(([name, data]) => [name, { data, updatedAt: Date.now() }]));
  const state = { writes: [], reads: [], failWrites: new Set(), corruptWrites: new Set() };
  return {
    state,
    entries,
    names: () => [...entries.keys()],
    // Storage-enumeration parity with createKvCache/createNodeCache: the
    // scheduler and the freshness dashboard discover work from storage, so a
    // store that can't list looks identical to an empty one.
    async list(prefix) {
      return [...entries.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, entry]) => ({ name, data: entry.data }));
    },
    async getEntry(name) {
      state.reads.push(name);
      if (!entries.has(name)) return null;
      const entry = entries.get(name);
      return { data: entry.data, updatedAt: entry.updatedAt };
    },
    async getStale(name) {
      const entry = await this.getEntry(name);
      return entry ? entry.data : null;
    },
    async get(name, maxAgeMs) {
      state.reads.push(name);
      if (!entries.has(name)) return null;
      const entry = entries.get(name);
      if (Date.now() - entry.updatedAt > maxAgeMs) return null;
      return entry.data;
    },
    async listNames(prefix) {
      return [...entries.keys()].filter((name) => name.startsWith(prefix));
    },
    async remove(name) {
      entries.delete(name);
    },
    // '*' in either set applies to every key, for tests that can't know a
    // generated version id in advance.
    shouldCorrupt: (name) => state.corruptWrites.has(name) || state.corruptWrites.has('*'),
    async set(name, data, options = {}) {
      state.writes.push({ name, options });
      if (state.failWrites.has(name) || state.failWrites.has('*')) {
        if (options.strict) {
          const error = new Error('simulated storage write failure');
          error.code = 'STORAGE_WRITE_FAILED';
          throw error;
        }
        return { stored: false };
      }
      const stored = (state.corruptWrites.has(name) || state.corruptWrites.has('*')) && typeof data === 'string'
        ? `${data}<!-- corrupted -->`
        : data;
      entries.set(name, { data: stored, updatedAt: Date.now() });
      return { stored: true };
    }
  };
}
