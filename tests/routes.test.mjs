import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MINIMAL_M3U, buildGuide } from './fixtures.mjs';

// End-to-end coverage for the serving half of the incident: what a player
// (or curl) actually receives from /epg/<slug>.xml and /iptv/<slug>.m3u.
// Runs the real Express app against a temporary hosted-files directory, so it
// exercises the same shared/serve.js layer the Cloudflare Worker uses.
const IDS = ['example.one', 'example.two'];
let server;
let baseUrl;
let hostedDir;

before(async () => {
  process.env.IPTV4U_LOG_SILENT = '1';
  // The app is imported for its route table only — without this it would also
  // start its own listener on the default port and hold the process open.
  process.env.IPTV4U_NO_LISTEN = '1';
  hostedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv4u-routes-'));
  process.env.IPTV4U_HOSTED_DIR = hostedDir;
  process.env.IPTV4U_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv4u-routes-cache-'));
  const { app } = await import('../server.js');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  // Keep-alive sockets from fetch would otherwise hold the listener open and
  // hang the test process.
  server?.closeAllConnections?.();
  server?.close();
  try { fs.rmSync(hostedDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// The public all-slugs report masks slug names; find a row by the id the
// per-slug endpoint (which requires knowing the slug) hands back.
async function rowFor(report, slug) {
  const { id } = await (await fetch(`${baseUrl}/api/health/epg/${slug}`)).json();
  return report.slugs.find((row) => row.id === id);
}

async function publish(body) {
  const response = await fetch(`${baseUrl}/api/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

describe('published file routes', () => {
  test('a missing slug returns 404 JSON, never 200 with an empty body', async () => {
    const response = await fetch(`${baseUrl}/epg/nothing-here.xml`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'EPG_NOT_FOUND');
    assert.equal(body.slug, 'nothing-here');

    const playlistResponse = await fetch(`${baseUrl}/iptv/nothing-here.m3u`);
    assert.equal(playlistResponse.status, 404);
    assert.equal((await playlistResponse.json()).code, 'PLAYLIST_NOT_FOUND');
  });

  test('a published pair is served with player-compatible types and cache headers', async () => {
    const result = await publish({ slug: 'serving', m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, programmesPerChannel: 48 }) });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);

    const epg = await fetch(`${baseUrl}/epg/serving.xml`);
    assert.equal(epg.status, 200);
    assert.equal(epg.headers.get('content-type'), 'application/xml; charset=utf-8');
    assert.equal(epg.headers.get('x-content-type-options'), 'nosniff');
    assert.match(epg.headers.get('cache-control'), /max-age=300/);
    assert.ok(epg.headers.get('etag'));
    assert.ok(epg.headers.get('last-modified'));
    assert.equal(epg.headers.get('x-epg-freshness'), 'fresh');
    assert.match(await epg.text(), /^<\?xml version="1\.0" encoding="UTF-8"\?>/);

    const m3u = await fetch(`${baseUrl}/iptv/serving.m3u`);
    assert.equal(m3u.status, 200);
    assert.equal(m3u.headers.get('content-type'), 'audio/x-mpegurl; charset=utf-8');
    assert.ok((await m3u.text()).startsWith('#EXTM3U'));
  });

  test('HEAD works and reports the same length as GET', async () => {
    const head = await fetch(`${baseUrl}/epg/serving.xml`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'application/xml; charset=utf-8');
    assert.equal(await head.text(), '');
    const get = await fetch(`${baseUrl}/epg/serving.xml`);
    assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
  });

  test('an expired published guide is served but marked stale rather than silently', async () => {
    // Published while current, then read with the clock moved past its last
    // programme — the production situation, where a guide ages out in KV.
    await publish({ slug: 'ageing', m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, hoursAhead: 1 }) });
    const { resolveHostedFile, assessPublishedHealth } = await import('../shared/epg-service.js');
    const { createNodeCache } = await import('../shared/node-cache.js');
    const store = createNodeCache(hostedDir);

    const threeDaysLater = Date.now() + 3 * 24 * 60 * 60 * 1000;
    const { buildHostedResponse } = await import('../shared/serve.js');
    const response = await buildHostedResponse(store, 'ageing', 'epg', { now: threeDaysLater });
    assert.equal(response.status, 200);
    assert.equal(response.freshness, 'expired');
    assert.equal(response.headers['X-EPG-Freshness'], 'expired');
    assert.match(response.headers.Warning, /Stale/);

    const health = await assessPublishedHealth(store, 'ageing', { now: threeDaysLater });
    assert.equal(health.status, 'stale');
    assert.equal(health.epg.currentOrFutureProgrammes, 0);
    assert.equal(await resolveHostedFile(store, 'ageing', 'epg') !== null, true);
  });

  test('corrupt content falls back to the last known good version when one exists', async () => {
    const store = (await import('../shared/node-cache.js')).createNodeCache(hostedDir);
    const { publishFiles } = await import('../shared/epg-service.js');
    const { buildHostedResponse } = await import('../shared/serve.js');
    const good = buildGuide({ ids: IDS, hoursAhead: 48 });
    await publishFiles(store, 'rollback', { m3uContent: MINIMAL_M3U, xmlContent: good });
    const second = await publishFiles(store, 'rollback', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, programmesPerChannel: 48 }) });
    // Simulate the active version being corrupted in storage after the fact —
    // the case where serving *something* validated beats serving nothing.
    await store.set(`hosted:rollback:versions:${second.version}:epg`, 'not xml at all');
    await store.set('hosted:rollback:xml', 'not xml at all');

    const response = await buildHostedResponse(store, 'rollback', 'epg');
    assert.equal(response.status, 200);
    assert.equal(response.fallback, true);
    assert.equal(response.headers['X-Hosted-Fallback'], 'last-known-good');
    assert.match(response.body, /<tv/);
  });

  test('an invalid publication is refused with stage-specific diagnostics', async () => {
    const result = await publish({ slug: 'bad', m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: ['other.id'], expired: true }) });
    assert.equal(result.status, 422);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.code, 'PUBLISH_VALIDATION_FAILED');
    assert.ok(Array.isArray(result.json.details.errors));
    assert.ok(result.json.details.errors.length > 0);
    // Nothing was published, so the endpoint 404s rather than serving anything.
    const epg = await fetch(`${baseUrl}/epg/bad.xml`);
    assert.equal(epg.status, 404);
  });

  test('the health endpoint reports counts and no credentials', async () => {
    const response = await fetch(`${baseUrl}/api/health/epg/serving`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.playlist.channels, 2);
    assert.equal(body.epg.channels, 2);
    assert.equal(body.mapping.matchedIds, 2);
    assert.equal(body.storage.activeVersion.startsWith('v'), true);
    // Reported before anything is wrong with it: a healthy guide with no
    // renewal schedule is degraded and carries the expiry countdown.
    assert.equal(body.status, 'degraded');
    assert.equal(body.refresh.enabled, false);
    assert.ok(body.expiry.at);
    assert.equal(/m3u8|example\.invalid/.test(JSON.stringify(body)), false);
  });

  test('the all-slugs freshness endpoint reports every published guide and its refresh state', async () => {
    const response = await fetch(`${baseUrl}/api/health/epg`);
    assert.equal(response.status, 200, 'the collection route must not be shadowed by /api/health/epg/:slug');
    const body = await response.json();
    assert.ok(Array.isArray(body.slugs));
    assert.ok(body.slugs.length >= 2);

    // Every dashboard column is present for every slug, including the one the
    // incident was about: published, fresh, and renewing from nowhere.
    for (const row of body.slugs) {
      assert.equal(row.slug, null, 'slug names are not listed publicly');
      assert.match(row.id, /^[0-9a-f]{12}$/);
      assert.ok('status' in row && 'refresh' in row && 'guideAgeMs' in row && 'currentOrFutureProgrammes' in row);
      assert.equal(typeof row.refresh.enabled, 'boolean');
    }

    assert.equal(JSON.stringify(body).includes('serving'), false, 'no slug name anywhere in the public report');
    const serving = await rowFor(body, 'serving');
    assert.equal(serving.published, true);
    assert.equal(serving.refresh.configured, false);
    assert.equal(serving.refresh.enabled, false);
    assert.ok(serving.warnings.some((warning) => warning.code === 'NO_AUTO_REFRESH'));
    assert.equal(/m3u8|example\.invalid/.test(JSON.stringify(body)), false);
  });

  test('saving an auto-refresh config makes that slug report itself as renewed', async () => {
    const save = await fetch(`${baseUrl}/api/refresh-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Never fetched: this only checks what the report says about the
      // schedule, not that a refresh succeeds.
      body: JSON.stringify({ slug: 'serving', m3uUrl: 'http://example.invalid/list.m3u', intervalKey: '24h' })
    });
    assert.equal(save.status, 200);

    const body = await (await fetch(`${baseUrl}/api/health/epg`)).json();
    const row = await rowFor(body, 'serving');
    assert.equal(row.refresh.configured, true);
    assert.equal(row.refresh.enabled, true);
    assert.equal(row.refresh.intervalKey, '24h');
    assert.equal(row.refresh.paused, false);
    assert.equal(row.warnings.some((warning) => warning.code === 'NO_AUTO_REFRESH'), false);
    assert.equal(row.status, 'healthy');
  });

  test('a fixed-time schedule round-trips through the API and reports when it will run', async () => {
    const save = await fetch(`${baseUrl}/api/refresh-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'serving',
        m3uUrl: 'http://example.invalid/list.m3u',
        intervalKey: null,
        dailyAtHour: 3,
        timeZone: 'Australia/Sydney'
      })
    });
    assert.equal(save.status, 200);
    const saved = (await save.json()).config;
    assert.equal(saved.dailyAtHour, 3);
    assert.equal(saved.timeZone, 'Australia/Sydney');
    assert.equal(saved.intervalKey, null);

    const health = await (await fetch(`${baseUrl}/api/health/epg/serving`)).json();
    assert.equal(health.refresh.mode, 'daily-at');
    assert.equal(health.refresh.enabled, true);
    assert.equal(health.refresh.dailyAtHour, 3);
    assert.equal(health.refresh.timeZone, 'Australia/Sydney');
    assert.ok(health.refresh.nextRunAt, 'the dashboard can show when the next evening run is');
    assert.equal(new Date(health.refresh.nextRunAt).getUTCMinutes(), 0, 'on the hour');

    const report = await (await fetch(`${baseUrl}/api/health/epg`)).json();
    const row = await rowFor(report, 'serving');
    assert.equal(row.renewal, 'auto');
    assert.equal(row.status, 'healthy');
  });

  test('an out-of-range hour is rejected with a usable message', async () => {
    const response = await fetch(`${baseUrl}/api/refresh-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'serving', m3uUrl: 'http://example.invalid/list.m3u', dailyAtHour: 27 })
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /whole hour from 0 to 23/);
  });

  test('a config saved with the interval set to Off is reported as paused, not as enabled', async () => {
    await fetch(`${baseUrl}/api/refresh-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'serving', m3uUrl: 'http://example.invalid/list.m3u', intervalKey: null })
    });
    const body = await (await fetch(`${baseUrl}/api/health/epg`)).json();
    const row = await rowFor(body, 'serving');
    assert.equal(row.refresh.configured, true);
    assert.equal(row.refresh.paused, true);
    assert.ok(row.warnings.some((warning) => warning.code === 'AUTO_REFRESH_PAUSED'));
  });

  test('a first-time user is told what will expire and can fix it without reading anything', async () => {
    // 1. Publish. The response itself has to flag the missing renewal, because
    //    this is the only moment the user is looking at the result.
    const published = await publish({ slug: 'first-timer', m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, programmesPerChannel: 48 }) });
    assert.equal(published.status, 200);
    const expiryWarning = published.json.warnings.find((w) => w.code === 'GUIDE_WILL_EXPIRE_WITHOUT_REFRESH');
    assert.ok(expiryWarning, 'publishing with no auto-refresh must say so in the publish response');
    assert.ok(expiryWarning.expiresInMs > 0, 'and say how long the guide has left');

    // 2. The slug is marked WILL EXPIRE, with a countdown, before anything is
    //    broken — this is what the post-publish summary and dashboard show.
    const before = await (await fetch(`${baseUrl}/api/health/epg/first-timer`)).json();
    assert.equal(before.refresh.enabled, false);
    assert.equal(before.status, 'degraded');
    assert.ok(before.expiry.inMs > 0);
    assert.ok(before.warnings.some((w) => w.includes('Nothing is scheduled to renew')));

    // 3. One click, no navigation, no documentation: enable Daily.
    const enabled = await fetch(`${baseUrl}/api/refresh-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'first-timer', m3uUrl: 'http://example.invalid/list.m3u', intervalKey: '24h' })
    });
    assert.equal(enabled.status, 200);

    // 4. And the result is verifiable in the same view.
    const after = await (await fetch(`${baseUrl}/api/health/epg/first-timer`)).json();
    assert.equal(after.status, 'healthy');
    assert.equal(after.refresh.enabled, true);
    assert.equal(after.refresh.due, true, 'a newly enabled schedule is due immediately, which is what the UI shows as "due now"');
    assert.equal(after.expiry.expired, false);
    assert.equal(after.warnings.some((w) => w.includes('Nothing is scheduled to renew')), false);

    const report = await (await fetch(`${baseUrl}/api/health/epg`)).json();
    const row = await rowFor(report, 'first-timer');
    assert.equal(row.renewal, 'auto');
    assert.equal(row.attentionRank, 4);
  });

  test('slug lookups are case-insensitive but never traverse out of the store', async () => {
    const upper = await fetch(`${baseUrl}/epg/SERVING.xml`);
    assert.equal(upper.status, 200);
    const traversal = await fetch(`${baseUrl}/epg/..%2F..%2Fetc%2Fpasswd.xml`);
    assert.notEqual(traversal.status, 200);
    const empty = await fetch(`${baseUrl}/api/health/epg/${encodeURIComponent('  ')}`);
    assert.equal(empty.status, 200);
    assert.equal((await empty.json()).status, 'missing');
  });
});
