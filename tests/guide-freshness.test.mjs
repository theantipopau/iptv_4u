import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  publishFiles,
  saveRefreshConfig,
  getRefreshConfig,
  listRefreshConfigs,
  describeRefreshSchedule,
  isRefreshDue,
  zonedParts,
  isValidTimeZone,
  runDueAutoRefreshes,
  assessAllPublishedHealth,
  assessPublishedHealth
} from '../shared/epg-service.js';
import { MINIMAL_M3U, buildGuide, memoryStore } from './fixtures.mjs';

// The production incident these tests pin down: a guide is published once,
// nothing ever renews it, and a few days later every programme in it has
// already ended. Nothing about the publication is "broken" — the endpoint
// still returns 200, the XMLTV still parses, the identifiers still match —
// so the only way to see it before a viewer does is to check, separately,
// how much schedule is left and whether anything is scheduled to renew it.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// A run that actually republishes needs every channel to short-circuit to a
// seeded override, or it would attempt a real network search. The guide comes
// from the override's own guideUrl.
const M3U_ONE = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="example.one" tvg-name="Example One",Example One',
  'http://example.invalid/one.m3u8',
  ''
].join('\n');

const dataUrl = (mime, body) => `data:${mime},${encodeURIComponent(body)}`;

function overrideFor(name, channelId, guideUrl) {
  return [name, {
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
  }];
}

/** Publish one slug whose guide covers the next `hours` of schedule. */
async function publishSlug(store, slug, { hours = 48, now = Date.now() } = {}) {
  const xml = buildGuide({ ids: ['example.one', 'example.two'], programmesPerChannel: hours, now });
  return publishFiles(store, slug, { m3uContent: MINIMAL_M3U, xmlContent: xml, expectProgrammes: true, now });
}

const codesOf = (warnings) => warnings.map((w) => w.code);
const rowFor = (report, slug) => report.slugs.find((row) => row.slug === slug);

describe('an unrefreshed guide ageing out (production incident regression)', () => {
  test('a fresh guide with no auto-refresh is flagged before anything breaks', async () => {
    const store = memoryStore();
    const now = Date.now();
    await publishSlug(store, 'matt', { hours: 48, now });

    const report = await assessAllPublishedHealth(store, { now });
    const row = rowFor(report, 'matt');

    assert.ok(row, 'a published slug must appear in the freshness report');
    assert.equal(row.published, true);
    assert.equal(row.freshness, 'fresh');
    assert.equal(row.currentOrFutureProgrammes, 96);
    // The warning that did not exist before: nothing is going to renew this.
    assert.ok(codesOf(row.warnings).includes('NO_AUTO_REFRESH'));
    assert.equal(row.refresh.enabled, false);
    assert.equal(row.refresh.configured, false);
    assert.equal(row.status, 'degraded');
  });

  test('the same guide, days later, is reported as expired with nothing renewed it', async () => {
    const store = memoryStore();
    const published = Date.now();
    await publishSlug(store, 'matt', { hours: 48, now: published });

    const later = published + 5 * DAY_MS;
    const report = await assessAllPublishedHealth(store, { now: later });
    const row = rowFor(report, 'matt');

    assert.equal(row.freshness, 'expired');
    assert.equal(row.status, 'stale', 'the overall report is stale — what the UI warns on');
    assert.equal(row.currentOrFutureProgrammes, 0);
    assert.ok(row.scheduleRemainingMs < 0, 'the schedule ran out in the past');
    assert.ok(codesOf(row.warnings).includes('GUIDE_EXPIRED'));
    assert.ok(codesOf(row.warnings).includes('NO_AUTO_REFRESH'));

    // The warning has to be actionable and player-facing, not a bare code.
    const expired = row.warnings.find((w) => w.code === 'GUIDE_EXPIRED');
    assert.match(expired.message, /already ended/);
    assert.match(expired.message, /no EPG/);

    // Exactly what the endpoint would have said throughout the outage: still
    // published, still valid, still being served.
    assert.equal(row.published, true);
    assert.equal(report.status, 'stale');
    assert.ok(report.warnings.some((w) => w.slug === 'matt' && w.code === 'GUIDE_EXPIRED'));
  });

  test('the current/future count is live, not the frozen publish-time snapshot', async () => {
    const store = memoryStore();
    const published = Date.now();
    await publishSlug(store, 'counted', { hours: 48, now: published });

    // The manifest records 96 current-or-future programmes at publish time.
    // Half a day later that number must have fallen, or the dashboard is
    // reassuring the user with a figure that can only ever be stale.
    assert.equal((await store.getStale('hosted:counted:manifest')).epgCurrentOrFuturePrograms, 96);

    const report = await assessAllPublishedHealth(store, { now: published + 24 * HOUR_MS + 60_000 });
    const row = rowFor(report, 'counted');
    assert.ok(row.currentOrFutureProgrammes < 96, `still claiming ${row.currentOrFutureProgrammes} current/future`);
    assert.ok(row.currentOrFutureProgrammes > 0, 'half the schedule is still ahead');
    assert.equal(row.freshness, 'fresh');
  });

  test('with deep: false only the manifest is needed, for a cheap freshness-only check', async () => {
    const store = memoryStore();
    const published = Date.now();
    await publishSlug(store, 'shallow', { hours: 48, now: published });

    const report = await assessAllPublishedHealth(store, { now: published + 5 * DAY_MS, deep: false });
    const row = rowFor(report, 'shallow');
    assert.equal(row.freshness, 'expired');
    assert.ok(codesOf(row.warnings).includes('GUIDE_EXPIRED'));
    assert.equal(row.currentOrFutureProgrammes, null, 'no count is claimed when nothing was read');
  });
});

describe('auto-refresh scheduling', () => {
  test('a due config is run by the shared tick and the guide is renewed', async () => {
    const cache = memoryStore();
    const store = memoryStore();
    const guideUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 48 }));
    await store.set('overrides:mkttest', Object.fromEntries([overrideFor('Example One', 'example.one', guideUrl)]));

    // Published a week ago, from a schedule that has since run out.
    const published = Date.now() - 7 * DAY_MS;
    await publishFiles(store, 'mkttest', {
      m3uContent: M3U_ONE,
      xmlContent: buildGuide({ ids: ['example.one'], programmesPerChannel: 48, now: published }),
      expectProgrammes: true,
      now: published
    });

    const before = await assessAllPublishedHealth(store, { now: published + 7 * DAY_MS });
    assert.equal(rowFor(before, 'mkttest').freshness, 'expired');

    const config = await saveRefreshConfig(store, {
      slug: 'mkttest',
      m3uUrl: dataUrl('text/plain', M3U_ONE),
      intervalKey: '6h'
    });
    assert.equal(isRefreshDue(config), true, 'a config that has never run is due immediately');

    const tick = await runDueAutoRefreshes(cache, store, '', { now: published + 7 * DAY_MS });
    assert.equal(tick.checked, 1);
    assert.equal(tick.due, 1);
    assert.equal(tick.ran, 1);
    assert.equal(tick.failed, 0);

    const after = await assessAllPublishedHealth(store, { now: Date.now() });
    const row = rowFor(after, 'mkttest');
    assert.equal(row.freshness, 'fresh', 'the renewal fixed the aged-out guide');
    assert.equal(row.refresh.enabled, true);
    assert.equal(row.refresh.lastRunStatus, 'ok');
    assert.ok(row.refresh.nextRunAt, 'the next run is scheduled and reported');
    assert.equal(codesOf(row.warnings).includes('GUIDE_EXPIRED'), false);
    assert.equal(codesOf(row.warnings).includes('NO_AUTO_REFRESH'), false);
    assert.equal(row.status, 'healthy');
  });

  test('the tick only runs configs that are actually due', async () => {
    const cache = memoryStore();
    const store = memoryStore();
    const guideUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 48 }));
    await store.set('overrides:recent', Object.fromEntries([overrideFor('Example One', 'example.one', guideUrl)]));

    const config = await saveRefreshConfig(store, {
      slug: 'recent',
      m3uUrl: dataUrl('text/plain', M3U_ONE),
      intervalKey: '24h'
    });
    // Pretend it ran an hour ago.
    await store.set('refresh-config:recent', { ...config, lastRunAt: Date.now() - HOUR_MS }, { ttlSeconds: null });

    const tick = await runDueAutoRefreshes(cache, store, '');
    assert.equal(tick.checked, 1);
    assert.equal(tick.due, 0);
    assert.equal(tick.results[0].reason, 'not-due');
    assert.equal(await store.getStale('hosted:recent:xml'), null, 'nothing was republished');
  });

  test('a config saved with no interval is reported as paused and never runs', async () => {
    const cache = memoryStore();
    const store = memoryStore();

    // This is the trap: the UI used to default its interval selector to
    // "Off", store the config anyway, and report success. The config exists,
    // reads back fine, and is silently inert forever.
    const config = await saveRefreshConfig(store, {
      slug: 'paused-slug',
      m3uUrl: dataUrl('text/plain', M3U_ONE),
      intervalKey: null
    });

    assert.equal(isRefreshDue(config), false);
    assert.deepEqual(await listRefreshConfigs(store), [config]);
    assert.equal((await getRefreshConfig(store, 'paused-slug')).slug, 'paused-slug');

    const schedule = describeRefreshSchedule(config);
    assert.equal(schedule.configured, true);
    assert.equal(schedule.enabled, false);
    assert.equal(schedule.paused, true, 'distinct from "not configured" so the UI can say which');

    const tick = await runDueAutoRefreshes(cache, store, '');
    assert.equal(tick.due, 0);
    assert.equal(tick.results[0].reason, 'paused');
    assert.equal(await store.getStale('hosted:paused-slug:xml'), null);
  });

  test('a schedule that fails is reported as failing rather than as enabled', async () => {
    const cache = memoryStore();
    const store = memoryStore();
    const brokenUrl = dataUrl('text/html', '<html><body>502 Bad Gateway</body></html>');
    await store.set('overrides:broken', Object.fromEntries([overrideFor('Example One', 'example.one', brokenUrl)]));
    await publishSlug(store, 'broken', { hours: 48 });

    const config = await saveRefreshConfig(store, {
      slug: 'broken',
      m3uUrl: dataUrl('text/plain', M3U_ONE),
      intervalKey: '6h'
    });
    await store.set('refresh-config:broken', { ...config, lastRunAt: Date.now() - 7 * HOUR_MS }, { ttlSeconds: null });

    const tick = await runDueAutoRefreshes(cache, store, '');
    assert.equal(tick.failed, 1);

    const report = await assessAllPublishedHealth(store);
    const row = rowFor(report, 'broken');
    assert.equal(row.refresh.enabled, true);
    assert.equal(row.refresh.lastRunStatus, 'error');
    assert.ok(codesOf(row.warnings).includes('AUTO_REFRESH_FAILING'));
  });

  test('one failing slug does not stop the others from refreshing', async () => {
    const cache = memoryStore();
    const store = memoryStore();
    const goodUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 48 }));
    const brokenUrl = dataUrl('text/html', '<html>nope</html>');
    await store.set('overrides:aa', Object.fromEntries([overrideFor('Example One', 'example.one', brokenUrl)]));
    await store.set('overrides:zz', Object.fromEntries([overrideFor('Example One', 'example.one', goodUrl)]));
    await publishSlug(store, 'aa', { hours: 48 });
    await publishSlug(store, 'zz', { hours: 48 });

    await saveRefreshConfig(store, { slug: 'aa', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '6h' });
    await saveRefreshConfig(store, { slug: 'zz', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '6h' });

    const tick = await runDueAutoRefreshes(cache, store, '');
    assert.equal(tick.checked, 2);
    assert.equal(tick.ran, 2);
    assert.equal(tick.failed, 1);
    assert.equal(tick.results.find((r) => r.slug === 'zz').status, 'ok');
  });
});

describe('expiry prediction and the publish-time safeguard', () => {
  test('a healthy publication with no auto-refresh warns that it will expire anyway', async () => {
    const store = memoryStore();
    const now = Date.now();
    const result = await publishFiles(store, 'warned', {
      m3uContent: MINIMAL_M3U,
      xmlContent: buildGuide({ ids: ['example.one', 'example.two'], programmesPerChannel: 48, now }),
      expectProgrammes: true,
      now
    });

    const warning = result.warnings.find((w) => w.code === 'GUIDE_WILL_EXPIRE_WITHOUT_REFRESH');
    assert.ok(warning, 'publishing without a renewal schedule must say so at publish time');
    assert.equal(warning.message, 'This guide appears healthy but will eventually expire unless auto-refresh is enabled.');
    assert.ok(warning.expiresAt, 'the warning carries the expiry time so the UI can count down');
    assert.ok(warning.expiresInMs > 0);
    assert.equal(warning.paused, false);
  });

  test('the warning becomes a paused-warning when a config exists with no interval', async () => {
    const store = memoryStore();
    await saveRefreshConfig(store, { slug: 'halfway', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: null });
    const result = await publishFiles(store, 'halfway', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: ['example.one', 'example.two'], programmesPerChannel: 48 }) });
    const warning = result.warnings.find((w) => w.code === 'GUIDE_WILL_EXPIRE_WITHOUT_REFRESH');
    assert.equal(warning.paused, true, 'a config that can never run is distinguishable from no config');
  });

  test('no warning once a real interval is configured', async () => {
    const store = memoryStore();
    const now = Date.now();
    await saveRefreshConfig(store, { slug: 'renewed', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '24h' });
    const result = await publishFiles(store, 'renewed', {
      m3uContent: MINIMAL_M3U,
      xmlContent: buildGuide({ ids: ['example.one', 'example.two'], programmesPerChannel: 48, now }),
      expectProgrammes: true,
      now
    });
    assert.equal(result.warnings.some((w) => w.code === 'GUIDE_WILL_EXPIRE_WITHOUT_REFRESH'), false);
  });

  test('every report carries a countdown, in both directions', async () => {
    const store = memoryStore();
    const HOUR_MS = 60 * 60 * 1000;
    const published = Date.now();
    await publishSlug(store, 'countdown', { hours: 72, now: published });

    const fresh = rowFor(await assessAllPublishedHealth(store, { now: published }), 'countdown');
    assert.equal(fresh.expiry.expired, false);
    assert.ok(fresh.expiry.inMs > 48 * HOUR_MS, 'about three days of schedule left');
    assert.ok(fresh.expiry.at);

    const goneBy = await assessAllPublishedHealth(store, { now: published + 4 * DAY_MS });
    const expired = rowFor(goneBy, 'countdown');
    assert.equal(expired.expiry.expired, true);
    assert.ok(expired.expiry.inMs < 0, 'a negative countdown is how long ago it ran out');
    assert.equal(expired.currentOrFutureProgrammes, 0);
  });

  test('the single-slug health view reports the same countdown and renewal state', async () => {
    const store = memoryStore();
    const published = Date.now();
    await publishSlug(store, 'one-slug', { hours: 72, now: published });

    const health = await assessPublishedHealth(store, 'one-slug', { now: published });
    assert.equal(health.expiry.expired, false);
    assert.ok(health.expiry.inMs > 0);
    assert.equal(health.epg.expiresAt, health.expiry.at);
    assert.equal(health.refresh.enabled, false);
    assert.equal(health.status, 'degraded');

    const later = await assessPublishedHealth(store, 'one-slug', { now: published + 4 * DAY_MS });
    assert.equal(later.expiry.expired, true);
    assert.equal(later.epg.freshness, 'expired');
    assert.equal(later.status, 'stale');
  });
});

describe('fixed time-of-day refresh', () => {
  // 2026-09-18 03:00 in Australia/Sydney (UTC+10) is 2026-09-17T17:00Z.
  const AT_3AM_SYDNEY = {
    slug: 'evening',
    m3uUrl: 'http://example.invalid/list.m3u',
    intervalKey: null,
    dailyAtHour: 3,
    timeZone: 'Australia/Sydney'
  };
  const THREE_AM_UTC = Date.parse('2026-09-17T17:00:00Z');

  test('a daily-at config is due only inside the hour the user chose, in their zone', () => {
    assert.equal(isRefreshDue(AT_3AM_SYDNEY, Date.parse('2026-09-17T16:00:00Z')), false, '02:00 local — an hour early');
    assert.equal(isRefreshDue(AT_3AM_SYDNEY, THREE_AM_UTC), true, '03:00 local — the chosen hour');
    assert.equal(isRefreshDue(AT_3AM_SYDNEY, Date.parse('2026-09-17T17:30:00Z')), true, '03:30 local — still inside the chosen hour');
    assert.equal(isRefreshDue(AT_3AM_SYDNEY, Date.parse('2026-09-17T18:00:00Z')), false, '04:00 local — the hour has passed');
  });

  test('it runs once per local day, and again the next local day', () => {
    const ranAt = Date.parse('2026-09-17T17:02:00Z'); // 03:02 local
    const config = { ...AT_3AM_SYDNEY, lastRunAt: ranAt };

    assert.equal(isRefreshDue(config, Date.parse('2026-09-17T17:30:00Z')), false, 'already ran inside this hour');
    assert.equal(isRefreshDue(config, Date.parse('2026-09-17T18:00:00Z')), false);
    assert.equal(isRefreshDue(config, THREE_AM_UTC + DAY_MS), true, 'same time tomorrow');
    assert.equal(isRefreshDue(config, THREE_AM_UTC + 2 * DAY_MS), true);
  });

  test('a manual refresh earlier the same local day counts as that day\u2019s run', () => {
    // The user pressed Refresh Now at 22:00 local; the 03:00 run the next
    // morning is a new local day, so it still happens — but a manual run at
    // 01:00 local on the same day means 03:00 has nothing to do.
    const manualEarlier = Date.parse('2026-09-17T15:00:00Z'); // 01:00 local on the 18th
    assert.equal(isRefreshDue({ ...AT_3AM_SYDNEY, lastRunAt: manualEarlier }, THREE_AM_UTC), false);
  });

  test('the chosen hour is interpreted in the user\u2019s zone, not the server\u2019s', () => {
    // The same UTC instant is 03:00 in Sydney but 13:00 in New York, so a
    // Sydney config must not fire on New York's clock or vice versa.
    const newYork = { ...AT_3AM_SYDNEY, timeZone: 'America/New_York' };
    assert.equal(isRefreshDue(newYork, THREE_AM_UTC), false);
    // 03:00 in New York (EDT, UTC-4) is 07:00Z.
    assert.equal(isRefreshDue(newYork, Date.parse('2026-09-17T07:00:00Z')), true);
  });

  test('a half-hour zone runs at :30, the only check inside the chosen hour', () => {
    // Asia/Kolkata is UTC+5:30, so the hourly tick lands at :30 past each hour.
    const kolkata = { ...AT_3AM_SYDNEY, timeZone: 'Asia/Kolkata' };
    assert.equal(isRefreshDue(kolkata, Date.parse('2026-09-17T21:00:00Z')), false, '02:30 local — before the hour');
    assert.equal(isRefreshDue(kolkata, Date.parse('2026-09-17T21:30:00Z')), true, '03:00 local');
    assert.equal(isRefreshDue(kolkata, Date.parse('2026-09-17T22:00:00Z')), true, '03:30 local — still inside the hour');
    assert.equal(isRefreshDue(kolkata, Date.parse('2026-09-17T22:30:00Z')), false, '04:00 local — done');
  });

  test('the schedule reports itself as daily-at, with the next run', async () => {
    const store = memoryStore();
    const config = await saveRefreshConfig(store, AT_3AM_SYDNEY);
    assert.equal(config.intervalKey, null, 'a fixed time and a rolling interval do not coexist');
    assert.equal(config.dailyAtHour, 3);
    assert.equal(config.timeZone, 'Australia/Sydney');

    const schedule = describeRefreshSchedule(config, THREE_AM_UTC);
    assert.equal(schedule.mode, 'daily-at');
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.paused, false);
    assert.equal(schedule.due, true);
    assert.equal(schedule.nextRunAt, '2026-09-17T17:00:00.000Z');
  });

  test('switching back to an interval clears the fixed time', async () => {
    const store = memoryStore();
    await saveRefreshConfig(store, AT_3AM_SYDNEY);
    const back = await saveRefreshConfig(store, { slug: 'evening', m3uUrl: 'http://example.invalid/list.m3u', intervalKey: '12h' });
    assert.equal(back.dailyAtHour, null);
    assert.equal(back.intervalKey, '12h');
    assert.equal(back.timeZone, null);
    assert.equal(describeRefreshSchedule(back).mode, 'interval');
  });

  test('changing only the schedule does not silently drop a custom guide source', async () => {
    const store = memoryStore();
    const saved = await saveRefreshConfig(store, {
      ...AT_3AM_SYDNEY,
      customGuideUrl: 'http://example.invalid/extra.xml'
    });
    assert.equal(saved.customGuideUrl, 'http://example.invalid/extra.xml');

    // Exactly what a caller changing the time (or the scheduler re-saving after
    // a run) sends: no customGuideUrl field at all.
    const rescheduled = await saveRefreshConfig(store, {
      slug: AT_3AM_SYDNEY.slug,
      m3uUrl: AT_3AM_SYDNEY.m3uUrl,
      dailyAtHour: 21,
      timeZone: 'Australia/Sydney'
    });
    assert.equal(rescheduled.customGuideUrl, 'http://example.invalid/extra.xml', 'the custom guide survives');
    assert.equal(rescheduled.dailyAtHour, 21);

    // Sending an explicit empty string is how a user clears it.
    const cleared = await saveRefreshConfig(store, {
      slug: AT_3AM_SYDNEY.slug,
      m3uUrl: AT_3AM_SYDNEY.m3uUrl,
      customGuideUrl: '',
      intervalKey: '24h'
    });
    assert.equal(cleared.customGuideUrl, null);
  });

  test('an impossible hour or an unknown zone is rejected rather than stored', async () => {
    const store = memoryStore();
    await assert.rejects(() => saveRefreshConfig(store, { ...AT_3AM_SYDNEY, dailyAtHour: 24 }), /whole hour from 0 to 23/);
    await assert.rejects(() => saveRefreshConfig(store, { ...AT_3AM_SYDNEY, dailyAtHour: 3.5 }), /whole hour from 0 to 23/);
    await assert.rejects(() => saveRefreshConfig(store, { ...AT_3AM_SYDNEY, timeZone: 'Mars/Olympus' }), /Unknown time zone/);
    assert.equal(await store.getStale('refresh-config:evening'), null);
  });

  test('the cron tick runs it once, and the guide is renewed at that hour', async () => {
    const cache = memoryStore();
    const store = memoryStore();
    const guideUrl = dataUrl('text/xml', buildGuide({ ids: ['example.one'], programmesPerChannel: 48 }));
    await store.set('overrides:evening', Object.fromEntries([overrideFor('Example One', 'example.one', guideUrl)]));
    await saveRefreshConfig(store, { ...AT_3AM_SYDNEY, m3uUrl: dataUrl('text/plain', M3U_ONE) });

    const early = await runDueAutoRefreshes(cache, store, '', { now: Date.parse('2026-09-17T16:00:00Z') });
    assert.equal(early.due, 0, 'nothing runs an hour early');

    const onTime = await runDueAutoRefreshes(cache, store, '', { now: THREE_AM_UTC });
    assert.equal(onTime.due, 1);
    assert.equal(onTime.ran, 1);
    const recorded = await store.getStale('refresh-config:evening');
    assert.equal(recorded.lastRunStatus, 'ok');

    const again = await runDueAutoRefreshes(cache, store, '', { now: Date.parse('2026-09-17T17:30:00Z') });
    assert.equal(again.due, 0, 'once per local day, not once per tick inside the hour');
  });
});

describe('interval drift', () => {
  test('a 24h config anchored just after an hourly tick runs at the same hour the next day', () => {
    // Regression: the due-check used to be exact, so a run finishing at 17:02
    // was 23h58m old at the next day's 17:00 tick — not due — and slipped to
    // 18:00, then 19:00, walking an hour later every day.
    const ranAt = Date.parse('2026-09-17T17:02:00Z');
    const config = { slug: 'drift', m3uUrl: 'http://example.invalid/list.m3u', intervalKey: '24h', lastRunAt: ranAt };

    assert.equal(isRefreshDue(config, Date.parse('2026-09-18T17:00:00Z')), true, 'same hour, next day');
    assert.equal(isRefreshDue(config, Date.parse('2026-09-18T16:00:00Z')), false, 'an hour early is still early');
    assert.equal(isRefreshDue(config, Date.parse('2026-09-18T18:00:00Z')), true);
  });

  test('the tolerance never makes a config due early', () => {
    const ranAt = Date.parse('2026-09-17T17:02:00Z');
    const config = { slug: 'drift', m3uUrl: 'x', intervalKey: '6h', lastRunAt: ranAt };
    assert.equal(isRefreshDue(config, ranAt + 5 * 60 * 60 * 1000), false, '5h55m in — not yet');
    assert.equal(isRefreshDue(config, ranAt + 6 * 60 * 60 * 1000), true);
  });
});

describe('attention ordering and scheduler health', () => {
  test('expired slugs sort first, then expiring soon, then unrenewed, then healthy', async () => {
    const store = memoryStore();
    const now = Date.now();
    await publishSlug(store, 'healthy-one', { hours: 240, now });
    await publishSlug(store, 'unrenewed', { hours: 240, now });
    await publishSlug(store, 'expired-one', { hours: 48, now: now - 5 * DAY_MS });
    await publishSlug(store, 'soon', { hours: 6, now });
    await saveRefreshConfig(store, { slug: 'healthy-one', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '24h' });
    const cfg = await store.getStale('refresh-config:healthy-one');
    await store.set('refresh-config:healthy-one', { ...cfg, lastRunAt: now - 60_000, lastRunStatus: 'ok' }, { ttlSeconds: null });

    const report = await assessAllPublishedHealth(store, { now });
    assert.deepEqual(report.slugs.map((row) => row.slug), ['expired-one', 'soon', 'unrenewed', 'healthy-one']);
    assert.deepEqual(report.slugs.map((row) => row.attentionRank), [0, 1, 3, 4]);
    assert.deepEqual(report.attention, { expired: 1, expiringSoon: 1, noRefresh: 3, overdue: 0 });
    assert.equal(report.status, 'stale');
  });

  test('a config nothing has executed is reported as overdue rather than as enabled-and-fine', async () => {
    const store = memoryStore();
    const now = Date.now();
    await publishSlug(store, 'stalled', { hours: 240, now });
    const config = await saveRefreshConfig(store, { slug: 'stalled', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '6h' });
    // Last ran three days ago against a 6h interval: enabled on paper, dead in practice.
    await store.set('refresh-config:stalled', { ...config, lastRunAt: now - 3 * DAY_MS }, { ttlSeconds: null });

    const report = await assessAllPublishedHealth(store, { now });
    const row = rowFor(report, 'stalled');
    assert.equal(row.renewal, 'overdue');
    assert.equal(row.refresh.enabled, true);
    assert.ok(codesOf(row.warnings).includes('AUTO_REFRESH_OVERDUE'));
    assert.equal(report.attention.overdue, 1);
    assert.deepEqual(report.scheduler.overdue, ['stalled']);
  });

  test('a freshly enabled config is not accused of being overdue before its first tick', async () => {
    const store = memoryStore();
    const now = Date.now();
    await publishSlug(store, 'just-enabled', { hours: 240, now });
    await saveRefreshConfig(store, { slug: 'just-enabled', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '6h' });

    const report = await assessAllPublishedHealth(store, { now });
    const row = rowFor(report, 'just-enabled');
    assert.equal(row.renewal, 'auto', 'it is due now, which is what enabled means; a tick has not been missed yet');
    assert.equal(codesOf(row.warnings).includes('AUTO_REFRESH_OVERDUE'), false);
  });

  test('a scheduler that has never run anything is called out, because every slug looks fine', async () => {
    const store = memoryStore();
    const now = Date.now();
    await publishSlug(store, 'aa', { hours: 240, now });
    await publishSlug(store, 'bb', { hours: 240, now });
    for (const slug of ['aa', 'bb']) {
      const config = await saveRefreshConfig(store, { slug, m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '6h' });
      // Enabled well past the grace period, and lastRunAt is still null: the
      // Cron Trigger that should have run these is not reaching them.
      await store.set(`refresh-config:${slug}`, { ...config, createdAt: now - 3 * DAY_MS }, { ttlSeconds: null });
    }

    const report = await assessAllPublishedHealth(store, { now });
    assert.equal(report.scheduler.enabledConfigs, 2);
    assert.equal(report.scheduler.observed, false);
    assert.deepEqual(report.scheduler.neverRun, ['aa', 'bb']);
    assert.deepEqual(report.scheduler.neverRanAndOverdue, ['aa', 'bb']);
    const warning = report.warnings.find((w) => w.code === 'SCHEDULER_NOT_OBSERVED');
    assert.match(warning.message, /Cron Trigger/);
    assert.match(warning.message, /not running it \(aa, bb\)/);
  });

  test('a config enabled moments ago is not yet evidence either way, so nothing is claimed', async () => {
    const store = memoryStore();
    const now = Date.now();
    await publishSlug(store, 'brand-new', { hours: 240, now });
    await saveRefreshConfig(store, { slug: 'brand-new', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '24h' });

    const report = await assessAllPublishedHealth(store, { now });
    assert.equal(report.scheduler.neverRun.length, 1);
    assert.equal(report.scheduler.observed, null, 'unknown, not "broken" — the next tick has not happened yet');
    assert.equal(report.warnings.some((w) => w.code === 'SCHEDULER_NOT_OBSERVED'), false);
  });

  test('a manual run before the first tick is not mistaken for a working scheduler', async () => {
    const store = memoryStore();
    const now = Date.now();
    await publishSlug(store, 'poked', { hours: 240, now });
    const config = await saveRefreshConfig(store, { slug: 'poked', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '6h' });
    // Refresh Now once, three days ago, and nothing since: lastRunAt is set, so
    // "has anything ever run" would say yes, while the truth is the schedule
    // has not executed for three days.
    await store.set('refresh-config:poked', { ...config, lastRunAt: now - 3 * DAY_MS, lastRunStatus: 'ok' }, { ttlSeconds: null });

    const report = await assessAllPublishedHealth(store, { now });
    assert.equal(report.scheduler.lastRunAt, now - 3 * DAY_MS);
    assert.equal(rowFor(report, 'poked').renewal, 'overdue');
    assert.ok(report.warnings.some((w) => w.code === 'AUTO_REFRESH_OVERDUE' && w.slug === 'poked'));
    // A stray lastRunAt must not be read as a healthy scheduler.
    assert.equal(report.scheduler.observed, false);
    assert.ok(report.warnings.some((w) => w.code === 'SCHEDULER_NOT_OBSERVED'));
  });

  test('a scheduler that has run at least one config is reported as running', async () => {
    const store = memoryStore();
    const now = Date.now();
    await publishSlug(store, 'cc', { hours: 240, now });
    const config = await saveRefreshConfig(store, { slug: 'cc', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '24h' });
    await store.set('refresh-config:cc', { ...config, lastRunAt: now - 3600_000, lastRunStatus: 'ok' }, { ttlSeconds: null });

    const report = await assessAllPublishedHealth(store, { now });
    assert.equal(report.scheduler.observed, true, 'ran within its interval: nothing overdue');
    assert.equal(report.scheduler.lastRunAt, now - 3600_000);
    assert.deepEqual(report.scheduler.overdue, []);
    assert.equal(report.warnings.some((w) => w.code === 'SCHEDULER_NOT_OBSERVED'), false);
  });
});

describe('the freshness report covers every published slug', () => {
  test('the two health views agree about a playlist published with no guide at all', async () => {
    const store = memoryStore();
    // Playlist only: production has exactly this shape (a slug whose guide was
    // never published), and the collection view used to call it "invalid"
    // while the single-slug view called it "degraded".
    await publishFiles(store, 'playlist-only', { m3uContent: MINIMAL_M3U });

    const report = await assessAllPublishedHealth(store);
    const row = rowFor(report, 'playlist-only');
    const health = await assessPublishedHealth(store, 'playlist-only');

    assert.equal(row.status, 'degraded');
    assert.equal(row.hasGuide, false, 'the dashboard can distinguish "no guide" from "age not recorded"');
    assert.equal(health.status, 'degraded');
    assert.ok(codesOf(row.warnings).includes('GUIDE_MISSING'));
    assert.ok(health.warnings.some((warning) => warning.includes('No guide is published for this slug')));
    // Absent is not the same as broken: a guide that IS there but malformed is
    // still invalid in both views.
    assert.equal(row.freshness, 'unknown');
  });

  test('a slug published before manifests existed reports a real guide age from the stored write time', async () => {
    const store = memoryStore({
      'hosted:legacy-aged:m3u': MINIMAL_M3U,
      'hosted:legacy-aged:xml': buildGuide({ ids: ['example.one', 'example.two'], programmesPerChannel: 48 })
    });
    // The envelope's write time stands in for a missing manifest publishedAt.
    const writtenAt = Date.now() - 2 * DAY_MS;
    store.entries.get('hosted:legacy-aged:xml').updatedAt = writtenAt;

    const report = await assessAllPublishedHealth(store);
    const row = rowFor(report, 'legacy-aged');
    assert.equal(row.hasGuide, true);
    assert.equal(row.publishedAtSource, 'legacy-write-time');
    assert.ok(Math.abs(row.guideAgeMs - 2 * DAY_MS) < 5000, `expected ~2 days, got ${row.guideAgeMs}ms`);

    const health = await assessPublishedHealth(store, 'legacy-aged');
    assert.equal(health.storage.publishedAt, new Date(writtenAt).toISOString());
  });

  test('a leftover config with nothing published degrades the instance, it does not invalidate it', async () => {
    const store = memoryStore();
    const now = Date.now();
    await publishSlug(store, 'real-guide', { hours: 240, now });
    await saveRefreshConfig(store, { slug: 'ghost', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '24h' });

    const report = await assessAllPublishedHealth(store, { now });
    assert.equal(rowFor(report, 'ghost').status, 'missing');
    assert.equal(report.status, 'degraded', 'one unpublished config must not relabel every published guide as invalid');
    assert.equal(report.attention.noRefresh, 1);
  });

  test('a genuinely broken published guide still makes the instance invalid', async () => {
    const store = memoryStore({
      'hosted:broken:m3u': MINIMAL_M3U,
      'hosted:broken:xml': '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'
    });
    const report = await assessAllPublishedHealth(store);
    assert.equal(rowFor(report, 'broken').status, 'invalid');
    assert.equal(report.status, 'invalid');
  });

  test('a slug published before manifests existed still appears', async () => {
    const store = memoryStore({
      'hosted:legacy:m3u': MINIMAL_M3U,
      'hosted:legacy:xml': buildGuide({ ids: ['example.one', 'example.two'], programmesPerChannel: 48 })
    });
    const report = await assessAllPublishedHealth(store);
    const row = rowFor(report, 'legacy');
    assert.ok(row, 'legacy keys are grouped by slug, not skipped for lacking a manifest');
    assert.equal(row.published, true);
    assert.equal(row.refresh.configured, false);
  });

  test('a refresh config saved for a slug that was never published is surfaced too', async () => {
    const store = memoryStore();
    await saveRefreshConfig(store, { slug: 'orphan', m3uUrl: dataUrl('text/plain', M3U_ONE), intervalKey: '24h' });
    const report = await assessAllPublishedHealth(store);
    const row = rowFor(report, 'orphan');
    assert.equal(row.published, false);
    assert.equal(row.status, 'missing');
    // Surfaced, but it degrades the instance rather than invalidating guides
    // that are perfectly fine (see the next test).
    assert.equal(report.status, 'degraded');
  });

  test('an empty store reports nothing rather than an error', async () => {
    const report = await assessAllPublishedHealth(memoryStore());
    assert.deepEqual(report.slugs, []);
    assert.equal(report.count, 0);
    assert.equal(report.status, 'healthy');
  });

  test('the report never carries a stream URL or a credential', async () => {
    const store = memoryStore();
    await saveRefreshConfig(store, { slug: 'safe', m3uUrl: 'http://user:secret@example.invalid/list.m3u', intervalKey: '24h' });
    await publishSlug(store, 'safe', { hours: 48 });
    const serialized = JSON.stringify(await assessAllPublishedHealth(store));
    assert.equal(/secret/.test(serialized), false);
    assert.equal(/example\.invalid/.test(serialized), false);
  });
});
