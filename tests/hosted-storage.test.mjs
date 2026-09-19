import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKvCache, createHostedKvStore } from '../shared/kv-cache.js';
import { createNodeCache } from '../shared/node-cache.js';
import { publishFiles, resolveHostedFile, getHostedFile, isServableContent } from '../shared/epg-service.js';
import { MINIMAL_M3U, buildGuide, memoryStore } from './fixtures.mjs';

const IDS = ['example.one', 'example.two'];
const DAY_MS = 24 * 60 * 60 * 1000;

function fakeKv() {
  const puts = [];
  const values = new Map();
  return {
    puts,
    values,
    async get(name) { return values.has(name) ? values.get(name) : null; },
    async put(name, value, options) { puts.push({ name, options }); values.set(name, value); }
  };
}

function tempStore() {
  return createNodeCache(fs.mkdtempSync(path.join(os.tmpdir(), 'iptv4u-storage-')));
}

describe('KV cache adapter', () => {
  test('the EPG source cache keeps a long TTL backstop', async () => {
    const kv = fakeKv();
    const cache = createKvCache(kv);
    await cache.set('source:example', { channels: [] });
    assert.equal(kv.puts[0].options.expirationTtl, 30 * DAY_MS / 1000);
  });

  test('published files are stored with no expiry (regression: they used to inherit the 30-day cache TTL)', async () => {
    const kv = fakeKv();
    const store = createHostedKvStore(kv);
    await store.set('hosted:slug:m3u', '#EXTM3U\n');
    assert.equal(kv.puts[0].options.expirationTtl, undefined);
  });

  test('a per-call ttlSeconds override wins, including "never expire"', async () => {
    const kv = fakeKv();
    const cache = createKvCache(kv);
    await cache.set('a', 1, { ttlSeconds: null });
    await cache.set('b', 2, { ttlSeconds: 60 });
    assert.equal(kv.puts[0].options.expirationTtl, undefined);
    assert.equal(kv.puts[1].options.expirationTtl, 60);
  });

  test('a missing binding fails loudly instead of looking like an empty cache', async () => {
    const cache = createKvCache(undefined);
    await assert.rejects(() => cache.getStale('anything'), (error) => {
      assert.equal(error.code, 'STORAGE_BINDING_MISSING');
      assert.equal(error.status, 503);
      return true;
    });
    await assert.rejects(() => cache.set('anything', {}), (error) => error.code === 'STORAGE_BINDING_MISSING');
  });

  test('a best-effort cache write is ignored, a strict publication write is not', async () => {
    const kv = { async get() { return null; }, async put() { throw new Error('KV write failed'); } };
    const cache = createKvCache(kv);
    assert.deepEqual(await cache.set('cache-key', { a: 1 }), { stored: false });
    await assert.rejects(() => cache.set('published-key', 'x', { strict: true }), (error) => {
      assert.equal(error.code, 'STORAGE_WRITE_FAILED');
      return true;
    });
  });
});

describe('node filesystem adapter', () => {
  test('round-trips values and leaves no temporary files behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv4u-node-cache-'));
    const store = createNodeCache(dir);
    await store.set('hosted:slug:m3u', MINIMAL_M3U);
    assert.equal(await store.getStale('hosted:slug:m3u'), MINIMAL_M3U);
    assert.equal(await store.get('hosted:slug:m3u', 1000), MINIMAL_M3U);
    assert.equal(await store.get('hosted:slug:m3u', -1), null, 'a stale entry must not count as fresh');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  });

  test('accepts the same set options as the KV adapter', async () => {
    const store = tempStore();
    assert.deepEqual(await store.set('k', 'v', { strict: true, ttlSeconds: null }), { stored: true });
  });
});

describe('storage enumeration (list)', () => {
  test('KV list follows pagination and returns every entry under a prefix', async () => {
    const kv = fakeKv();
    const names = ['refresh-config:a', 'refresh-config:b', 'refresh-config:c'];
    kv.list = async ({ prefix, cursor }) => {
      const matching = names.filter((name) => name.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const page = matching.slice(start, start + 2);
      const complete = start + page.length >= matching.length;
      return { keys: page.map((name) => ({ name })), list_complete: complete, cursor: complete ? undefined : String(start + page.length) };
    };
    const store = createHostedKvStore(kv);
    for (const slug of ['a', 'b', 'c']) await store.set(`refresh-config:${slug}`, { slug });

    const listed = await store.list('refresh-config:');
    assert.deepEqual(listed.map((entry) => entry.name), names);
    assert.deepEqual(listed.map((entry) => entry.data.slug), ['a', 'b', 'c']);
  });

  test('a store whose binding cannot list fails loudly rather than looking empty', async () => {
    const kv = { async get() { return null; }, async put() {} }; // no list()
    const store = createKvCache(kv);
    await assert.rejects(() => store.list('hosted:'), (error) => {
      assert.equal(error.code, 'STORAGE_BINDING_MISSING');
      return true;
    });
  });

  test('the node adapter reverses its filename mangling back into key names', async () => {
    const store = tempStore();
    await store.set('refresh-config:my-slug', { slug: 'my-slug' });
    await store.set('hosted:my-slug:manifest', { activeVersion: 'v1' });
    await store.set('hosted:my-slug:versions:v1:epg', '<tv></tv>');

    assert.deepEqual(await store.list('refresh-config:'), [{ name: 'refresh-config:my-slug', data: { slug: 'my-slug' } }]);
    assert.deepEqual(
      (await store.list('hosted:')).map((entry) => entry.name).sort(),
      ['hosted:my-slug:manifest', 'hosted:my-slug:versions:v1:epg'],
      'version keys resolve back to their real key names, not mangled filenames'
    );
  });

  test('an empty directory lists nothing instead of throwing', async () => {
    const store = createNodeCache(fs.mkdtempSync(path.join(os.tmpdir(), 'iptv4u-empty-cache-')));
    assert.deepEqual(await store.list('hosted:'), []);
  });
});

describe('versioned publication', () => {
  test('writes version keys, a manifest and the legacy keys players read', async () => {
    const store = memoryStore();
    const xml = buildGuide({ ids: IDS, programmesPerChannel: 48 });
    const result = await publishFiles(store, 'versioned', { m3uContent: MINIMAL_M3U, xmlContent: xml });

    const names = store.names();
    assert.ok(names.includes(`hosted:versioned:versions:${result.version}:playlist`));
    assert.ok(names.includes(`hosted:versioned:versions:${result.version}:epg`));
    assert.ok(names.includes('hosted:versioned:manifest'));
    assert.ok(names.includes('hosted:versioned:m3u'), 'legacy player-facing key');
    assert.ok(names.includes('hosted:versioned:xml'), 'legacy player-facing key');

    const manifest = await store.getStale('hosted:versioned:manifest');
    assert.equal(manifest.activeVersion, result.version);
    assert.equal(manifest.playlistChannels, 2);
    assert.equal(manifest.epgChannels, 2);
    assert.equal(manifest.epgPrograms, 96, '48 hourly programmes on each of 2 channels');
    assert.equal(manifest.epgCurrentOrFuturePrograms, 96);
    assert.equal(manifest.identifierMatchCount, 2);
    assert.equal(manifest.guideFreshness, 'fresh');
    assert.match(manifest.contentHashes.epg, /^[a-f0-9]{64}$/);
    assert.ok(manifest.publishedAt);
  });

  test('the manifest never carries stream URLs or playlist contents', async () => {
    const store = memoryStore();
    const result = await publishFiles(store, 'versioned', {
      m3uContent: MINIMAL_M3U,
      xmlContent: buildGuide({ ids: IDS, programmesPerChannel: 48 })
    });
    const serialized = JSON.stringify(result.manifest);
    assert.equal(/m3u8|\/one\.m3u8|example\.invalid/.test(serialized), false);
  });

  test('the previous version is kept for rollback', async () => {
    const store = memoryStore();
    const first = await publishFiles(store, 'versioned', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, programmesPerChannel: 48 }) });
    const second = await publishFiles(store, 'versioned', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, programmesPerChannel: 96 }) });

    const manifest = await store.getStale('hosted:versioned:manifest');
    assert.equal(manifest.previousVersion, first.version);
    const rolledBack = await resolveHostedFile(store, 'versioned', 'epg', { version: first.version });
    assert.ok(rolledBack.content);
    assert.equal(second.manifest.previousVersion, first.version);
  });

  test('a read-after-write mismatch aborts the publication without promoting it', async () => {
    const store = memoryStore();
    const good = buildGuide({ ids: IDS, programmesPerChannel: 48 });
    const first = await publishFiles(store, 'versioned', { m3uContent: MINIMAL_M3U, xmlContent: good });

    // The store accepts the write but hands back something else — exactly the
    // silent-corruption case a plain put-then-hope publication misses.
    store.state.corruptWrites.add('*');
    await assert.rejects(
      () => publishFiles(store, 'versioned', { m3uContent: MINIMAL_M3U, xmlContent: good, now: Date.now() + 1 }),
      (error) => error.code === 'PUBLISH_READBACK_FAILED'
    );

    const manifest = await store.getStale('hosted:versioned:manifest');
    assert.equal(manifest.activeVersion, first.version, 'the live version must be untouched');
    assert.equal((await resolveHostedFile(store, 'versioned', 'epg')).content, good);
  });

  test('a storage write failure aborts the publication without promoting it', async () => {
    const store = memoryStore();
    const first = await publishFiles(store, 'versioned', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, programmesPerChannel: 48 }) });
    const before = store.names().length;

    // Fail every subsequent version-scoped write.
    const originalSet = store.set;
    store.set = async (name, data, options) => {
      if (name.includes(':versions:')) {
        store.state.failWrites.add(name);
        return originalSet(name, data, options);
      }
      return originalSet(name, data, options);
    };

    await assert.rejects(
      () => publishFiles(store, 'versioned', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, programmesPerChannel: 48 }), now: Date.now() + 5 }),
      (error) => error.code === 'PUBLISH_STORAGE_WRITE_FAILED'
    );
    const manifest = await store.getStale('hosted:versioned:manifest');
    assert.equal(manifest.activeVersion, first.version);
    assert.ok(store.names().length >= before);
  });
});

describe('backwards compatibility and resolution', () => {
  test('content published before the manifest existed is still served', async () => {
    // Exactly what's in production today: hosted:<slug>:xml with no manifest.
    const store = memoryStore({ 'hosted:legacy:xml': buildGuide({ ids: IDS, programmesPerChannel: 48 }) });
    const resolved = await resolveHostedFile(store, 'legacy', 'epg');
    assert.equal(resolved.source, 'legacy');
    assert.equal(resolved.version, null);
    assert.ok(resolved.content.includes('<tv'));
    assert.ok(await getHostedFile(store, 'legacy', 'xml'), 'the historical "xml" kind name still resolves');
    assert.ok(await getHostedFile(store, 'legacy', 'epg'));
  });

  test('the manifest is preferred over the legacy keys, so a pair is always served together', async () => {
    const store = memoryStore({
      'hosted:both:xml': '<tv>stale legacy copy</tv>',
      'hosted:both:manifest': { activeVersion: 'v1', publishedAt: new Date(0).toISOString() },
      'hosted:both:versions:v1:epg': buildGuide({ ids: IDS, programmesPerChannel: 48 })
    });
    const resolved = await resolveHostedFile(store, 'both', 'epg');
    assert.equal(resolved.source, 'version');
    assert.equal(resolved.version, 'v1');
  });

  test('a mixed pair is detectable: the M3U from one publication next to the guide from another', async () => {
    const playlist = '#EXTM3U\n#EXTINF:-1 tvg-id="example.one",One\nhttp://example.invalid/a.m3u8\n';
    const guide = buildGuide({ ids: ['unrelated.channel'], programmesPerChannel: 48 });
    const { analyzePlaylist, analyzeGuide, compareIdentifiers } = await import('../shared/validate.js');
    const comparison = compareIdentifiers(analyzePlaylist(playlist), analyzeGuide(guide));
    assert.equal(comparison.matchedIdCount, 0);
  });

  test('servable-content checks match what a player needs', () => {
    assert.equal(isServableContent('playlist', MINIMAL_M3U), true);
    assert.equal(isServableContent('playlist', ''), false);
    assert.equal(isServableContent('epg', buildGuide({ ids: IDS })), true);
    assert.equal(isServableContent('epg', '<tv></tv>'), false, 'a guide with no channels is not servable');
  });
});
