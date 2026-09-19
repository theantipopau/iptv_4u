import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Until this scheduler existed, nothing ran auto-refresh outside Cloudflare's
// cron trigger: a config saved on a local/self-hosted Express deployment was
// never executed by anything, so its guide aged out exactly like a slug with
// no config at all. This drives the real timer against a real store.

process.env.IPTV4U_LOG_SILENT = '1';
process.env.IPTV4U_NO_LISTEN = '1'; // import the app for its scheduler, not its listener
process.env.IPTV4U_REFRESH_TICK_MS = '50';

let hostedDir;
let stop;
let store;

const HOUR_MS = 60 * 60 * 1000;
const M3U_ONE = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="example.one" tvg-name="Example One",Example One',
  'http://example.invalid/one.m3u8',
  ''
].join('\n');

const dataUrl = (mime, body) => `data:${mime},${encodeURIComponent(body)}`;

/** Poll until `predicate` is true, or fail with a clear message. */
async function waitFor(predicate, { timeoutMs = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

before(async () => {
  hostedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv4u-scheduler-'));
  process.env.IPTV4U_HOSTED_DIR = hostedDir;
  process.env.IPTV4U_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv4u-scheduler-cache-'));

  const { startAutoRefreshScheduler } = await import('../server.js');
  const { createNodeCache } = await import('../shared/node-cache.js');
  const { saveRefreshConfig } = await import('../shared/epg-service.js');
  const { buildGuide } = await import('./fixtures.mjs');

  store = createNodeCache(hostedDir);
  const guideUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 48 }));
  // A seeded manual override short-circuits the channel search, so the run
  // never touches the network — the guide comes from the override's own URL.
  await store.set('overrides:tick', {
    'Example One': {
      channelId: 'example.one',
      channelName: 'Example One',
      source: 'test guide',
      logoUrl: null,
      guideUrl,
      canMergeGuide: true,
      tmdb: null,
      synthesize: false,
      score: 1,
      manual: true
    }
  });
  await saveRefreshConfig(store, { slug: 'tick', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '6h' });

  stop = startAutoRefreshScheduler();
});

after(() => {
  stop?.();
  try { fs.rmSync(hostedDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('local auto-refresh scheduler', () => {
  test('the running server refreshes a due config without anyone clicking anything', async () => {
    await waitFor(async () => {
      const config = await store.getStale('refresh-config:tick');
      return config?.lastRunAt != null;
    }, { label: 'the scheduler to run the due config' });

    const config = await store.getStale('refresh-config:tick');
    assert.equal(config.lastRunStatus, 'ok');
    assert.equal(config.lastRunChannelCount, 1);
    assert.ok(config.lastRunCurrentOrFutureCount > 0);

    // A real publication landed, through the same validated path /api/publish uses.
    const published = await store.getStale('hosted:tick:xml');
    assert.ok(published, 'the scheduled run published a guide');
    assert.match(published, /<channel id="example\.one">/);
    assert.match(await store.getStale('hosted:tick:m3u'), /tvg-id="example\.one"/);
    assert.ok((await store.getStale('hosted:tick:manifest')).activeVersion);
  });

  test('it does not re-run a config that is not due yet', async () => {
    const before = (await store.getStale('refresh-config:tick')).lastRunAt;
    // Several ticks' worth of waiting with a 6h interval: nothing should move.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = (await store.getStale('refresh-config:tick')).lastRunAt;
    assert.equal(after, before);
    assert.ok(Date.now() - after < HOUR_MS);
  });
});
