import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRefreshDue,
  ownPlaylistSlug,
  publishFiles,
  runAutoRefresh,
  saveRefreshConfig
} from '../shared/epg-service.js';
import { buildGuide, memoryStore } from './fixtures.mjs';

// Production failure (2026-09): the refresh source was the app's own
// https://<host>/iptv/matt.m3u. A Worker fetching its own custom domain gets a
// 522, so every scheduled run failed and the published guide aged out.

const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="example.one" tvg-name="Example One",Example One',
  'http://example.invalid/one.m3u8',
  ''
].join('\n');

const HOST = 'iptv.example.test';
const dataUrl = (mime, body) => `data:${mime},${encodeURIComponent(body)}`;

describe('refresh source is this app\'s own published playlist', () => {
  test('ownPlaylistSlug only matches /iptv/<slug>.m3u on a listed host', () => {
    assert.equal(ownPlaylistSlug(`https://${HOST}/iptv/matt.m3u`, [HOST]), 'matt');
    assert.equal(ownPlaylistSlug(`https://${HOST.toUpperCase()}/iptv/matt.m3u`, [` ${HOST} `]), 'matt');
    assert.equal(ownPlaylistSlug(`https://${HOST}/iptv/matt.m3u`, []), null, 'unlisted host is fetched normally');
    assert.equal(ownPlaylistSlug('https://provider.example/iptv/matt.m3u', [HOST]), null);
    assert.equal(ownPlaylistSlug(`https://${HOST}/epg/matt.xml`, [HOST]), null);
    assert.equal(ownPlaylistSlug('not a url', [HOST]), null);
  });

  test('a run reads the published playlist from storage instead of fetching it', async () => {
    const cache = memoryStore();
    const store = memoryStore();
    await publishFiles(store, 'matt', { m3uContent: M3U });
    const guideUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 48 }));
    await store.set('overrides:matt', {
      'Example One': {
        channelId: 'example.one', channelName: 'Example One', source: 'test guide', logoUrl: null,
        guideUrl, canMergeGuide: true, tmdb: null, synthesize: false, score: 1, manual: true
      }
    });
    const config = await saveRefreshConfig(store, { slug: 'matt', m3uUrl: `https://${HOST}/iptv/matt.m3u`, intervalKey: '24h' });

    const result = await runAutoRefresh(cache, store, '', config, { selfHosts: [HOST] });
    assert.equal(result.lastRunStatus, 'ok', result.lastRunError);
    assert.equal(result.lastRunChannelCount, 1);
    assert.ok(result.lastRunCurrentOrFutureCount > 0);
  });

  test('a self URL with nothing published fails with a clear code, not a fetch', async () => {
    const store = memoryStore();
    const config = await saveRefreshConfig(store, { slug: 'ghost', m3uUrl: `https://${HOST}/iptv/ghost.m3u`, intervalKey: '24h' });
    await assert.rejects(
      () => runAutoRefresh(memoryStore(), store, '', config, { selfHosts: [HOST] }),
      (error) => error.code === 'REFRESH_SOURCE_NOT_PUBLISHED'
    );
    const recorded = await store.getStale('refresh-config:ghost');
    assert.equal(recorded.lastRunStatus, 'error');
    assert.equal(recorded.lastRunErrorCode, 'REFRESH_SOURCE_NOT_PUBLISHED');
  });
});

describe('failed runs are retried on the next tick', () => {
  const HOUR = 60 * 60 * 1000;
  const ranAt = Date.parse('2026-09-22T17:01:00Z'); // 03:01 Sydney

  test('fixed-time config: a failure is retried an hour later, not tomorrow', () => {
    const base = { slug: 's', m3uUrl: 'http://x.invalid/a.m3u', dailyAtHour: 3, timeZone: 'Australia/Sydney', lastRunAt: ranAt };
    assert.equal(isRefreshDue({ ...base, lastRunStatus: 'error' }, ranAt + 30 * 60 * 1000), false, 'not straight away');
    assert.equal(isRefreshDue({ ...base, lastRunStatus: 'error' }, ranAt + HOUR), true, 'next hourly tick');
    assert.equal(isRefreshDue({ ...base, lastRunStatus: 'ok' }, ranAt + HOUR), false, 'a success still waits for tomorrow');
  });

  test('interval config: a failure is retried an hour later, not after the interval', () => {
    const base = { slug: 's', m3uUrl: 'http://x.invalid/a.m3u', intervalKey: '24h', lastRunAt: ranAt };
    assert.equal(isRefreshDue({ ...base, lastRunStatus: 'error' }, ranAt + HOUR), true);
    assert.equal(isRefreshDue({ ...base, lastRunStatus: 'ok' }, ranAt + HOUR), false);
  });

  test('a paused config is not revived by an old failure', () => {
    assert.equal(isRefreshDue({ slug: 's', m3uUrl: 'http://x.invalid/a.m3u', intervalKey: null, lastRunAt: ranAt, lastRunStatus: 'error' }, ranAt + HOUR), false);
  });
});
