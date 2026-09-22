import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGuideSubsetScanner, fetchGuideSubset } from '../shared/fetch-utils.js';
import { publishFiles, runAutoRefresh, saveRefreshConfig, getChannelPlan } from '../shared/epg-service.js';
import { buildGuide, memoryStore } from './fixtures.mjs';

const GUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="t">
  <channel id="keep.one"><display-name>Keep One</display-name><icon src="http://x.invalid/1.png"/></channel>
  <channel id="drop.me"><display-name>Drop</display-name></channel>
  <channel id='a&amp;b'><display-name>Quoted</display-name></channel>
  <channels-note>not a channel element</channels-note>
  <programme start="20260923000000 +0000" stop="20260923010000 +0000" channel="keep.one"><title>Kept</title></programme>
  <programme start="20260923000000 +0000" stop="20260923010000 +0000" channel="drop.me"><title>Dropped</title></programme>
  <programme start="20260923010000 +0000" stop="20260923020000 +0000" channel="keep.one"/>
  <programme start="20260923000000 +0000" stop="20260923010000 +0000" channel="a&amp;b"><title>Amp</title></programme>
</tv>`;

function scanInChunks(text, size, ids) {
  const scanner = createGuideSubsetScanner(ids);
  for (let i = 0; i < text.length; i += size) scanner.push(text.slice(i, i + size));
  return scanner.finish();
}

describe('guide subset scanner', () => {
  test('keeps only wanted channels and programmes, whatever the chunking', () => {
    const whole = scanInChunks(GUIDE, GUIDE.length, ['keep.one', 'a&b']);
    assert.equal(whole.channelCount, 2);
    assert.equal(whole.programmeCount, 3);
    assert.ok(!whole.xml.includes('Dropped'));
    assert.ok(!whole.xml.includes('channels-note'));
    for (const size of [1, 2, 3, 7, 13, 64]) {
      assert.equal(scanInChunks(GUIDE, size, ['keep.one', 'a&b']).xml, whole.xml, `chunk size ${size}`);
    }
  });

  test('reads a gzip guide from the network in a stream', async () => {
    const gz = await new Response(new Blob([GUIDE]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(gz, { status: 200 });
    try {
      const subset = await fetchGuideSubset('http://example.invalid/guide.xml.gz', ['keep.one']);
      assert.equal(subset.channelCount, 1);
      assert.equal(subset.programmeCount, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="example.one" tvg-name="Example One",Example One',
  'http://example.invalid/one.m3u8',
  '#EXTINF:-1 tvg-id="" tvg-name="Unmatched",Unmatched',
  'http://example.invalid/two.m3u8',
  '#EXTINF:-1 tvg-id="" tvg-name="Brand New",Brand New',
  'http://example.invalid/three.m3u8',
  ''
].join('\n');
const dataUrl = (mime, body) => `data:${mime},${encodeURIComponent(body)}`;

describe('plan-based renewal', () => {
  test('renews from the saved plan without searching, and counts new channels', async () => {
    const store = memoryStore();
    const guideUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 48 }));
    const plan = {
      'Example One': { channelId: 'example.one', channelName: 'Example One', guideUrl, canMergeGuide: true, logoUrl: null, tmdb: null, synthesize: false },
      Unmatched: { channelId: null }
    };
    await publishFiles(store, 'plan', { m3uContent: M3U, plan });
    assert.deepEqual(await getChannelPlan(store, 'plan'), plan);

    const config = await saveRefreshConfig(store, { slug: 'plan', m3uUrl: dataUrl('text/plain', M3U), intervalKey: '24h' });
    // An empty cache means any search would hit the network; the plan must make that unnecessary.
    const result = await runAutoRefresh(memoryStore(), store, '', config, { requirePlan: true });
    assert.equal(result.lastRunStatus, 'ok', result.lastRunError);
    assert.equal(result.lastRunPlanCount, 2);
    assert.equal(result.lastRunUnplannedCount, 1, '"Brand New" was not in the plan');
    assert.equal(result.lastRunGuideCount, 1);
    assert.ok(result.lastRunCurrentOrFutureCount > 0);
  });

  test('without a plan, a Worker-style run fails clearly and leaves the guide alone', async () => {
    const store = memoryStore();
    await publishFiles(store, 'noplan', { m3uContent: M3U });
    const config = await saveRefreshConfig(store, { slug: 'noplan', m3uUrl: dataUrl('text/plain', M3U), intervalKey: '24h' });
    const manifestBefore = await store.getStale('hosted:noplan:manifest');
    await assert.rejects(
      () => runAutoRefresh(memoryStore(), store, '', config, { requirePlan: true }),
      (error) => error.code === 'REFRESH_PLAN_MISSING'
    );
    assert.deepEqual(await store.getStale('hosted:noplan:manifest'), manifestBefore);
    assert.equal((await store.getStale('refresh-config:noplan')).lastRunErrorCode, 'REFRESH_PLAN_MISSING');
  });
});

describe('storage stays bounded', () => {
  test('only the active and previous versions are kept', async () => {
    const store = memoryStore();
    const guide = buildGuide({ ids: ['example.one'], programmesPerChannel: 48 });
    const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="example.one",Example One\nhttp://example.invalid/one.m3u8\n';
    let now = Date.now();
    for (let i = 0; i < 4; i += 1) {
      await publishFiles(store, 'prune', { m3uContent: m3u, xmlContent: guide.replace('</tv>', `<!-- ${i} --></tv>`), now: now += 1000 });
    }
    const versions = new Set(store.names()
      .filter((name) => name.startsWith('hosted:prune:versions:'))
      .map((name) => name.split(':')[3]));
    const manifest = await store.getStale('hosted:prune:manifest');
    assert.deepEqual([...versions].sort(), [manifest.activeVersion, manifest.previousVersion].sort());
  });
});
