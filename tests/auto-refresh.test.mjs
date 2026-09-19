import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runAutoRefresh, saveRefreshConfig } from '../shared/epg-service.js';
import { analyzeGuide, compareIdentifiers, analyzePlaylist } from '../shared/validate.js';
import { buildGuide, memoryStore } from './fixtures.mjs';

// runAutoRefresh is the path that keeps a published slug current, and the one
// that would have republished a guide with nothing left in it. It's driven
// here entirely from `data:` URLs plus pre-seeded manual overrides, so nothing
// touches the network: an override short-circuits the channel search, and the
// guide comes from the override's own guideUrl.

// One channel per case unless a test needs two: every channel in the playlist
// must have a seeded override, or the run would fall through to a real
// network search (which these tests deliberately never do).
const M3U_ONE = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="example.one" tvg-name="Example One",Example One',
  'http://example.invalid/one.m3u8',
  ''
].join('\n');

const M3U_TWO = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="example.one" tvg-name="Example One",Example One',
  'http://example.invalid/one.m3u8',
  '#EXTINF:-1 tvg-id="example.two" tvg-name="Example Two",Example Two',
  'http://example.invalid/two.m3u8',
  ''
].join('\n');

const dataUrl = (mime, body) => `data:${mime},${encodeURIComponent(body)}`;
const overrideFor = (name, channelId, guideUrl) => [
  name,
  {
    channelId,
    channelName: name,
    source: 'test guide',
    logoUrl: null,
    guideUrl,
    canMergeGuide: true,
    tmdb: null,
    synthesize: false,
    score: 1,
    manual: true
  }
];

async function seedConfig(store, { slug, m3uUrl, customGuideUrl }) {
  return saveRefreshConfig(store, {
    slug,
    m3uUrl,
    customGuideUrl,
    intervalKey: '6h'
  });
}

describe('auto-refresh publication safety', () => {
  test('a run with usable guide data publishes and records safe metrics', async () => {
    const cache = memoryStore();
    const store = memoryStore();
    const guideUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 48 }));

    await store.set('overrides:fresh', Object.fromEntries([overrideFor('Example One', 'example.one', guideUrl)]));
    const config = await seedConfig(store, { slug: 'fresh', m3uUrl: dataUrl('text/plain', M3U_ONE) });

    const result = await runAutoRefresh(cache, store, '', config);
    assert.equal(result.lastRunStatus, 'ok');
    assert.equal(result.lastRunChannelCount, 1);
    assert.equal(result.lastRunOverrideCount, 1);
    assert.equal(result.lastRunCurrentOrFutureCount, 48);

    const published = await store.getStale('hosted:fresh:xml');
    const guide = analyzeGuide(published);
    assert.equal(guide.channelCount, 1);
    assert.ok(guide.currentOrFutureProgrammes > 0);
    assert.equal(guideFreshnessOf(published), 'fresh');

    // The playlist that was published still carries the same identifier.
    const playlist = await store.getStale('hosted:fresh:m3u');
    assert.match(playlist, /tvg-id="example\.one"/);
    assert.match(published, /<channel id="example\.one">/);
    assert.equal(compareIdentifiers(analyzePlaylist(playlist), guide).matchedIdCount, 1);
  });

  test('a run whose guide data has expired is refused, and the live guide survives', async () => {
    const cache = memoryStore();
    const store = memoryStore();

    // A healthy publication first (the state a real slug is in before its
    // sources go stale)…
    const goodUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 48 }));
    await store.set('overrides:ageing', Object.fromEntries([overrideFor('Example One', 'example.one', goodUrl)]));
    const config = await seedConfig(store, { slug: 'ageing', m3uUrl: dataUrl('text/plain', M3U_ONE) });
    await runAutoRefresh(cache, store, '', config);
    const publishedBefore = await store.getStale('hosted:ageing:xml');
    const versionBefore = (await store.getStale('hosted:ageing:manifest')).activeVersion;

    // …then every source on the next run only has programmes in the past.
    const staleUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], expired: true }));
    await store.set('overrides:ageing', Object.fromEntries([overrideFor('Example One', 'example.one', staleUrl)]));
    const config2 = await store.getStale('refresh-config:ageing');

    await assert.rejects(
      () => runAutoRefresh(cache, store, '', config2),
      (error) => {
        assert.equal(error.code, 'PUBLISH_VALIDATION_FAILED');
        return true;
      }
    );

    const recorded = await store.getStale('refresh-config:ageing');
    assert.equal(recorded.lastRunStatus, 'error');
    assert.equal(recorded.lastRunErrorCode, 'PUBLISH_VALIDATION_FAILED');

    // Nothing was promoted: same version, same guide as before the bad run.
    assert.equal(await store.getStale('hosted:ageing:xml'), publishedBefore);
    assert.equal((await store.getStale('hosted:ageing:manifest')).activeVersion, versionBefore);
  });

  test('one failing source does not discard the channels that did resolve', async () => {
    const cache = memoryStore();
    const store = memoryStore();
    const goodUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 48 }));
    const brokenUrl = dataUrl('text/xml', '<html><body>502 Bad Gateway</body></html>');

    await store.set('overrides:partial', Object.fromEntries([
      overrideFor('Example One', 'example.one', goodUrl),
      overrideFor('Example Two', 'example.two', brokenUrl)
    ]));
    const config = await seedConfig(store, { slug: 'partial', m3uUrl: dataUrl('text/plain', M3U_TWO) });

    const result = await runAutoRefresh(cache, store, '', config);
    assert.equal(result.lastRunStatus, 'ok');
    assert.equal(result.lastRunFailedCount, 1, 'the broken guide is counted as a failure');

    const guide = analyzeGuide(await store.getStale('hosted:partial:xml'));
    assert.equal(guide.channelCount, 1);
    assert.equal(guide.ids[0], 'example.one');
    assert.ok(guide.currentOrFutureProgrammes > 0);
  });

  test('a guide URL that is not XML at all is never merged into the published guide', async () => {
    const cache = memoryStore();
    const store = memoryStore();
    const notXmlUrl = dataUrl('text/html', '<!DOCTYPE html><html><body>not a guide</body></html>');
    await store.set('overrides:htmlish', Object.fromEntries([overrideFor('Example One', 'example.one', notXmlUrl)]));
    const config = await seedConfig(store, { slug: 'htmlish', m3uUrl: dataUrl('text/plain', M3U_ONE) });

    // No programmes and no m3u ids left in a guide → the gate blocks it
    // (an expected-programmes publication with nothing in it).
    await assert.rejects(
      () => runAutoRefresh(cache, store, '', config),
      (error) => error.code === 'PUBLISH_VALIDATION_FAILED'
    );
    assert.equal(await store.getStale('hosted:htmlish:xml'), null, 'nothing was published at all');
  });
});

function guideFreshnessOf(xml) {
  const analysis = analyzeGuide(xml);
  if (!analysis.programmeCount) return 'no-programmes';
  return analysis.currentOrFutureProgrammes > 0 ? 'fresh' : 'expired';
}
