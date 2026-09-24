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

describe('one-request build for Publish/Export', () => {
  test('builds both files from the plan without searching', async () => {
    const { buildPublication } = await import('../shared/epg-service.js');
    const guideUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 24 }));
    const plan = {
      'Example One': { channelId: 'example.one', channelName: 'Example One', guideUrl, canMergeGuide: true, logoUrl: 'http://example.invalid/one.png', tmdb: null, synthesize: false },
      Unmatched: { channelId: null },
      'Brand New': { channelId: 'brand.new', channelName: 'Brand New', logoUrl: 'http://example.invalid/new.png', canMergeGuide: false, synthesize: false, tmdb: null }
    };
    const result = await buildPublication(memoryStore(), '', { m3uText: M3U, plan });
    assert.equal(result.counts.guideCount, 1);
    assert.equal(result.counts.logoCount, 1);
    assert.equal(result.counts.unplannedCount, 0);
    assert.match(result.m3u, /tvg-id="brand\.new"/);
    assert.match(result.m3u, /tvg-logo="http:\/\/example\.invalid\/one\.png"/);
    assert.equal((result.xml.match(/<programme /g) || []).length, 24);
    assert.match(result.xml, /<channel id="brand\.new">/);
  });

  test('a loaded base guide keeps its other channels, and matched ids are replaced, not duplicated', async () => {
    const { buildPublication } = await import('../shared/epg-service.js');
    const guideUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 5 }));
    const baseXml = buildGuide({ ids: ['example.one', 'kept.other'], programmesPerChannel: 3 });
    const plan = { 'Example One': { channelId: 'example.one', channelName: 'Example One', guideUrl, canMergeGuide: true, logoUrl: null, tmdb: null, synthesize: false } };
    const result = await buildPublication(memoryStore(), '', { m3uText: M3U, plan, baseXml });
    assert.equal((result.xml.match(/channel="example\.one"/g) || []).length, 5);
    assert.equal((result.xml.match(/channel="kept\.other"/g) || []).length, 3);
  });

  test('rejects a request with no plan rather than searching', async () => {
    const { buildPublication } = await import('../shared/epg-service.js');
    await assert.rejects(() => buildPublication(memoryStore(), '', { m3uText: M3U, plan: {} }), (error) => error.code === 'BUILD_PLAN_MISSING');
  });
});

describe('public health report', () => {
  test('masks slug names, reveals only the one the caller names, and reads no guide bodies', async () => {
    const { publicHealthReport, publicSlugId } = await import('../shared/epg-service.js');
    const store = memoryStore();
    const guide = buildGuide({ ids: ['example.one'], programmesPerChannel: 24 });
    const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="example.one",Example One\nhttp://example.invalid/one.m3u8\n';
    await publishFiles(store, 'secret-one', { m3uContent: m3u, xmlContent: guide });
    await publishFiles(store, 'secret-two', { m3uContent: m3u, xmlContent: guide });
    store.state.reads.length = 0;

    const report = await publicHealthReport(store, { reveal: 'secret-one' });
    const text = JSON.stringify(report);
    assert.equal(text.includes('secret-two'), false);
    const mine = report.slugs.find((row) => row.slug === 'secret-one');
    assert.ok(mine, 'the caller’s own slug is named');
    assert.equal(mine.id, await publicSlugId(store, 'secret-one'));
    assert.equal(report.slugs.filter((row) => row.slug === null).length, 1);
    assert.equal(store.state.reads.some((name) => name.includes(':versions:') || name.endsWith(':xml')), false, 'no guide content read');
    assert.equal(mine.freshness, 'fresh');
  });
});

describe('public health report redaction', () => {
  test('a recorded run error keeps only the host of the URL it quotes', async () => {
    const { publicHealthReport } = await import('../shared/epg-service.js');
    const store = memoryStore();
    const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="example.one",Example One\nhttp://example.invalid/one.m3u8\n';
    await publishFiles(store, 'leaky', { m3uContent: m3u, xmlContent: buildGuide({ ids: ['example.one'], programmesPerChannel: 24 }) });
    await saveRefreshConfig(store, { slug: 'leaky', m3uUrl: 'https://host.example/iptv/leaky.m3u', intervalKey: '24h' });
    const config = await store.getStale('refresh-config:leaky');
    await store.set('refresh-config:leaky', { ...config, lastRunAt: Date.now(), lastRunStatus: 'error', lastRunError: 'Failed to fetch https://host.example/iptv/leaky.m3u and http://epg.provider.example/btv/SECRETTOKEN/x: HTTP 522' });
    const text = JSON.stringify(await publicHealthReport(store));
    assert.equal(text.includes('leaky'), false);
    assert.equal(text.includes('SECRETTOKEN'), false);
    assert.ok(text.includes('https://host.example/…'));
  });
});

describe('24/7 channels get a generated schedule', () => {
  const M3U_247 = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="24/7 Seinfeld S07 [VIP]" tvg-logo="http://example.invalid/s.png" group-title="24/7 Streams",24/7 Seinfeld S07 [VIP]',
    'http://example.invalid/a.m3u8',
    '#EXTINF:-1 group-title="24/7 Streams",24/7 Iron Man [VIP]',
    'http://example.invalid/b.m3u8',
    '#EXTINF:-1 tvg-id="real.247" group-title="News",News 24/7',
    'http://example.invalid/c.m3u8',
    ''
  ].join('\n');

  test('fills 24/7 channels without programmes, and never overrides a real guide', async () => {
    const { analyzeGuide } = await import('../shared/validate.js');
    const now = Date.parse('2026-09-24T10:30:00Z');
    const realGuide = buildGuide({ ids: ['real.247'], programmesPerChannel: 6, now });
    const plan = {
      '24/7 Seinfeld S07 [VIP]': { channelId: null },
      'News 24/7': { channelId: 'real.247', channelName: 'News', guideUrl: dataUrl('text/xml', realGuide), canMergeGuide: true, logoUrl: null, tmdb: null, synthesize: false }
    };
    const { buildFromPlan } = await import('../shared/epg-service.js');
    const { parseM3U } = await import('../shared/core.js');
    const result = await buildFromPlan(memoryStore(), '', { channels: parseM3U(M3U_247), plan, now });

    assert.equal(result.counts.synthesizedCount, 2, 'Seinfeld and Iron Man, not the channel with a real guide');
    assert.match(result.xml, /<title lang="en">Seinfeld Season 7<\/title>/);
    assert.match(result.xml, /<icon src="http:\/\/example\.invalid\/s\.png"/);
    assert.match(result.m3u, /tvg-id="247\.[^"]*iron-man[^"]*"/, 'a channel with no id is given one in the playlist too');
    assert.equal((result.xml.match(/channel="real\.247"/g) || []).length, 6, 'the real guide is untouched');

    const blocks = (result.xml.match(/channel="24\/7 Seinfeld S07 \[VIP\]"/g) || []).length;
    assert.ok(blocks >= 32 && blocks <= 34, `about four days of 3-hour blocks, got ${blocks}`);

    // Freshness follows the real schedule, not the generated one.
    const analysis = analyzeGuide(result.xml, { now });
    const realStop = Date.parse(analyzeGuide(realGuide, { now }).latestStop);
    assert.equal(Date.parse(analysis.latestStop), realStop);
    assert.equal(analysis.synthesizedProgrammes, blocks * 2);
  });
});

describe('24/7 titles', () => {
  test('known film series and provider typos get readable titles', async () => {
    const { twentyFourSevenTitle, twentyFourSevenDescription } = await import('../shared/core.js');
    assert.equal(twentyFourSevenTitle('24/7 Harry Poter [VIP]'), 'Harry Potter');
    assert.match(twentyFourSevenDescription('24/7 Harry Poter [VIP]'), /Harry Potter films on repeat/);
    assert.equal(twentyFourSevenTitle('24/7 The Hobbit And Lord Of TheRings [VIP]'), 'The Lord of the Rings & The Hobbit');
    assert.match(twentyFourSevenDescription('24/7 The Hobbit And Lord Of TheRings [VIP]'), /Lord of the Rings and The Hobbit films/);
    assert.equal(twentyFourSevenTitle('24/7 Bobs Burgers S11 [VIP]'), 'Bob’s Burgers Season 11');
    assert.equal(twentyFourSevenTitle('24/7 LAW & ORDER'), 'Law & Order');
    assert.equal(twentyFourSevenTitle('24/7 Planet Earth II [VIP]'), 'Planet Earth II');
    assert.equal(twentyFourSevenDescription('24/7 Iron Man [VIP]'), null);
  });
});
