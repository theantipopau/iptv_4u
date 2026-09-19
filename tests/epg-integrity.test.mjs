import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePlaylist,
  analyzeGuide,
  compareIdentifiers,
  assessPublication,
  guideFreshness,
  parseXmltvStamp,
  detectBodyKind,
  safeSourceLabel,
  slugHash
} from '../shared/validate.js';
import {
  publishFiles,
  resolveHostedFile,
  assessPublishedHealth,
  mergeGuide,
  resolveGuideChannel
} from '../shared/epg-service.js';
import { MINIMAL_M3U, PLAYLIST_WITHOUT_IDS, buildGuide, buildChannelOnlyGuide, memoryStore } from './fixtures.mjs';

const IDS = ['example.one', 'example.two'];
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The production incident
//
// TiViMate showed no EPG for any channel while the playlist still loaded. The
// published guide was valid XML, served HTTP 200, had 223 <channel> nodes and
// 16,121 <programme> nodes — every one of which had already ended, because the
// schedule snapshots it was built from only cover a few days and nothing
// re-checked or re-generated it. These tests pin that exact shape: a guide can
// be structurally perfect and still be useless, and the app must notice.
// ---------------------------------------------------------------------------

describe('published guide ageing out (production incident regression)', () => {
  test('a guide whose every programme has ended is detected, not treated as valid output', () => {
    const now = Date.now();
    const analysis = analyzeGuide(buildGuide({ ids: IDS, now, expired: true }), { now });

    assert.equal(analysis.validXml, true);
    assert.equal(analysis.channelCount, 2);
    assert.equal(analysis.programmeCount, 4);
    assert.equal(analysis.currentOrFutureProgrammes, 0);
    assert.equal(analysis.expiredProgrammes, 4);
    assert.deepEqual(analysis.errors.map((e) => e.code), ['GUIDE_EXPIRED']);
    assert.equal(guideFreshness(analysis, now), 'expired');
  });

  test('a guide that was healthy when published is reported as stale once it ages out', async () => {
    const now = Date.now();
    const store = memoryStore();
    // Published while the schedules were still current — precisely the
    // production situation: this publish was legitimate at the time.
    await publishFiles(store, 'incident', {
      m3uContent: MINIMAL_M3U,
      xmlContent: buildGuide({ ids: IDS, now }),
      now
    });

    const threeDaysLater = now + 3 * DAY;
    const health = await assessPublishedHealth(store, 'incident', { now: threeDaysLater });

    assert.equal(health.status, 'stale');
    assert.equal(health.epg.freshness, 'expired');
    assert.equal(health.epg.currentOrFutureProgrammes, 0);
    assert.equal(health.epg.programmes, 4);
    assert.ok(health.warnings.some((w) => /already ended/i.test(w)), `expected an expiry warning, got ${JSON.stringify(health.warnings)}`);
  });

  test('an expired guide cannot replace the live, still-valid one', async () => {
    const now = Date.now();
    const store = memoryStore();
    const goodGuide = buildGuide({ ids: IDS, now });
    const first = await publishFiles(store, 'incident', { m3uContent: MINIMAL_M3U, xmlContent: goodGuide, now });

    await assert.rejects(
      () => publishFiles(store, 'incident', {
        m3uContent: MINIMAL_M3U,
        xmlContent: buildGuide({ ids: IDS, now, expired: true }),
        expectProgrammes: true,
        now: now + DAY
      }),
      (error) => {
        assert.equal(error.code, 'PUBLISH_VALIDATION_FAILED');
        assert.equal(error.status, 422);
        assert.ok(error.details.errors.some((e) => e.code === 'GUIDE_EXPIRED'));
        return true;
      }
    );

    // Nothing was promoted: same version, same guide, still live.
    const resolved = await resolveHostedFile(store, 'incident', 'epg');
    assert.equal(resolved.content, goodGuide);
    assert.equal(resolved.version, first.version);
  });

  test('a guide whose programmes are all in the past is reported with zero usable programmes', () => {
    const now = Date.now();
    const analysis = analyzeGuide(buildGuide({ ids: IDS, now, expired: true }), { now });
    const metrics = assessPublication({ playlist: analyzePlaylist(MINIMAL_M3U), guide: analysis, now }).metrics;
    assert.equal(metrics.epgCurrentOrFuturePrograms, 0);
    assert.equal(metrics.guideFreshness, 'expired');
  });

  test('a guide with only a few hours left is flagged before it expires', () => {
    const now = Date.now();
    const soon = analyzeGuide(buildGuide({ ids: IDS, now, hoursAhead: 0 }), { now });
    const far = analyzeGuide(buildGuide({ ids: IDS, now, hoursAhead: 48 }), { now });
    assert.equal(guideFreshness(soon, now), 'ending-soon');
    assert.equal(guideFreshness(far, now), 'fresh');
  });
});

// ---------------------------------------------------------------------------
// The identifier contract: M3U tvg-id === XMLTV <channel id> === <programme channel>
// ---------------------------------------------------------------------------

describe('playlist <-> guide identifier contract', () => {
  test('ids that line up are reported as matched, in both directions', () => {
    const comparison = compareIdentifiers(
      analyzePlaylist(MINIMAL_M3U),
      analyzeGuide(buildGuide({ ids: IDS }))
    );
    assert.equal(comparison.matchedIdCount, 2);
    assert.equal(comparison.playlistIdsWithoutEpg, 0);
    assert.equal(comparison.guideIdsNotInPlaylist, 0);
    assert.equal(comparison.matchedIdsWithProgrammes, 2);
  });

  test('a case difference alone disconnects every channel', () => {
    const playlist = analyzePlaylist('#EXTM3U\n#EXTINF:-1 tvg-id="Example.One",Example One\nhttp://example.invalid/a.m3u8\n');
    const guide = analyzeGuide(buildGuide({ ids: ['example.one'] }));
    const comparison = compareIdentifiers(playlist, guide);
    assert.equal(comparison.matchedIdCount, 0);

    const assessment = assessPublication({ playlist, guide, comparison });
    assert.equal(assessment.ok, false);
    assert.ok(assessment.errors.some((e) => e.code === 'IDENTIFIERS_DISCONNECTED'));
  });

  test('publishing files with no shared identifier is refused', async () => {
    const store = memoryStore();
    await assert.rejects(
      () => publishFiles(store, 'disconnected', {
        m3uContent: MINIMAL_M3U,
        xmlContent: buildGuide({ ids: ['other.channel'] })
      }),
      (error) => {
        assert.equal(error.code, 'PUBLISH_VALIDATION_FAILED');
        assert.ok(error.details.errors.some((e) => e.code === 'IDENTIFIERS_DISCONNECTED'));
        return true;
      }
    );
    assert.equal(await resolveHostedFile(store, 'disconnected', 'epg'), null);
  });

  test('programmes referencing an undeclared channel id are counted', () => {
    const guide = analyzeGuide(
      '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n' +
        '  <channel id="example.one"><display-name>One</display-name></channel>\n' +
        '  <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="missing.id"><title>X</title></programme>\n</tv>\n'
    );
    assert.equal(guide.danglingProgrammeReferences, 1);
    assert.ok(guide.warnings.some((w) => w.code === 'GUIDE_DANGLING_PROGRAMMES'));
  });

  test('merge-guide never adds a channel under an id the playlist did not ask for', async () => {
    // The guide carries the same *display name* the caller was searching for,
    // but a different id. A name-based fallback used to silently add that
    // other id while the playlist kept its own tvg-id — leaving the channel
    // matched in the UI and blank in the player.
    const guideXml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="decoy.id"><display-name>Example One</display-name></channel>
  <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="decoy.id"><title>Decoy</title></programme>
</tv>`;

    await assert.rejects(
      () => mergeGuide({
        baseXml: '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="iptv-4u"></tv>',
        guideUrl: `data:text/xml,${encodeURIComponent(guideXml)}`,
        channelId: 'example.one',
        preferredName: 'Example One'
      }),
      (error) => {
        assert.equal(error.status, 404);
        assert.equal(error.code, 'GUIDE_CHANNEL_NOT_FOUND');
        return true;
      }
    );
  });

  test('a guide that only carries programmes still resolves to the requested id', () => {
    const guide = {
      channels: [],
      programmes: [{ '@_channel': 'example.one', '@_start': '20260101000000', '@_stop': '20260101010000' }]
    };
    const resolved = resolveGuideChannel(guide, 'example.one', 'Example One');
    assert.equal(resolved.id, 'example.one');
    assert.equal(resolveGuideChannel(guide, 'nope', 'Example One'), null);
  });

  test('every matched id is byte-identical in both published files', async () => {
    const store = memoryStore();
    const xml = buildGuide({ ids: IDS });
    await publishFiles(store, 'contract', { m3uContent: MINIMAL_M3U, xmlContent: xml });

    const playlist = (await resolveHostedFile(store, 'contract', 'playlist')).content;
    const epg = (await resolveHostedFile(store, 'contract', 'epg')).content;
    const comparison = compareIdentifiers(analyzePlaylist(playlist), analyzeGuide(epg));
    assert.equal(comparison.matchedIdCount, 2);
    for (const id of IDS) {
      assert.ok(playlist.includes(`tvg-id="${id}"`), `playlist lost ${id}`);
      assert.ok(epg.includes(`<channel id="${id}">`), `guide lost ${id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Publication gate
// ---------------------------------------------------------------------------

describe('pre-publication quality gate', () => {
  test('an empty guide cannot replace a valid one', async () => {
    const store = memoryStore();
    const good = buildGuide({ ids: IDS });
    await publishFiles(store, 'slug', { m3uContent: MINIMAL_M3U, xmlContent: good });

    await assert.rejects(
      () => publishFiles(store, 'slug', { m3uContent: MINIMAL_M3U, xmlContent: '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="iptv-4u">\n</tv>\n' }),
      (error) => {
        assert.ok(error.details.errors.some((e) => e.code === 'GUIDE_NO_CHANNELS'));
        return true;
      }
    );
    assert.equal((await resolveHostedFile(store, 'slug', 'epg')).content, good);
  });

  test('a channel-only guide cannot replace a guide that has programmes', async () => {
    const store = memoryStore();
    await publishFiles(store, 'slug', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS }) });

    await assert.rejects(
      () => publishFiles(store, 'slug', { m3uContent: MINIMAL_M3U, xmlContent: buildChannelOnlyGuide(IDS) }),
      (error) => {
        assert.ok(error.details.errors.some((e) => e.code === 'PROGRAMMES_LOST'));
        return true;
      }
    );
  });

  test('an HTML error page served as a guide is refused', async () => {
    const store = memoryStore();
    await assert.rejects(
      () => publishFiles(store, 'slug', { m3uContent: MINIMAL_M3U, xmlContent: '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>' }),
      (error) => {
        assert.ok(error.details.errors.some((e) => e.code === 'GUIDE_NOT_XML_HTML'));
        return true;
      }
    );
  });

  test('a JSON error document served as a guide is refused', async () => {
    const store = memoryStore();
    await assert.rejects(
      () => publishFiles(store, 'slug', { m3uContent: MINIMAL_M3U, xmlContent: '{"error":"rate limited"}' }),
      (error) => {
        assert.ok(error.details.errors.some((e) => e.code === 'GUIDE_NOT_XML_JSON'));
        return true;
      }
    );
  });

  test('an empty playlist is refused', async () => {
    const store = memoryStore();
    await assert.rejects(
      () => publishFiles(store, 'slug', { m3uContent: '#EXTM3U\n' }),
      (error) => {
        assert.ok(error.details.errors.some((e) => e.code === 'PLAYLIST_NO_CHANNELS'));
        return true;
      }
    );
  });

  test('a playlist with no tvg-id at all is refused, since no channel could ever show a guide', async () => {
    const store = memoryStore();
    await assert.rejects(
      () => publishFiles(store, 'slug', { m3uContent: PLAYLIST_WITHOUT_IDS }),
      (error) => {
        assert.ok(error.details.errors.some((e) => e.code === 'PLAYLIST_NO_IDS'));
        return true;
      }
    );
  });

  test('a playlist-only publication is still allowed (no guide supplied)', async () => {
    const store = memoryStore();
    const result = await publishFiles(store, 'slug', { m3uContent: MINIMAL_M3U });
    assert.equal(result.version.startsWith('v'), true);
    assert.equal(await resolveHostedFile(store, 'slug', 'playlist') !== null, true);
    assert.equal(await resolveHostedFile(store, 'slug', 'epg'), null);
  });

  test('a playlist with no ids is reported with blank count metrics, not silently passed', () => {
    const analysis = analyzePlaylist(PLAYLIST_WITHOUT_IDS);
    assert.equal(analysis.channelsWithTvgId, 0);
    assert.equal(analysis.blankTvgIdCount, 1);
  });

  test('duplicate tvg-ids are reported as a warning-level risk', () => {
    const duped = '#EXTM3U\n#EXTINF:-1 tvg-id="example.one",A\nhttp://example.invalid/a.m3u8\n#EXTINF:-1 tvg-id="example.one",B\nhttp://example.invalid/b.m3u8\n';
    const analysis = analyzePlaylist(duped);
    assert.deepEqual(analysis.duplicateIds, ['example.one']);
    const assessment = assessPublication({ playlist: analysis });
    assert.equal(assessment.ok, true);
    assert.ok(assessment.warnings.some((w) => w.code === 'PLAYLIST_DUPLICATE_IDS'));
  });

  test('covering only part of the playlist publishes with a warning, not a failure', () => {
    const assessment = assessPublication({
      playlist: analyzePlaylist(MINIMAL_M3U),
      guide: analyzeGuide(buildGuide({ ids: ['example.one'] }))
    });
    assert.equal(assessment.ok, true);
    assert.ok(assessment.warnings.some((w) => w.code === 'PLAYLIST_IDS_WITHOUT_EPG'));
  });
});

describe('health payload', () => {
  test('reports healthy for a current guide and never leaks published content', async () => {
    const store = memoryStore();
    await publishFiles(store, 'slug', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, hoursAhead: 48 }) });

    const health = await assessPublishedHealth(store, 'slug');
    assert.equal(health.published, true);
    assert.equal(health.playlist.channels, 2);
    assert.equal(health.epg.channels, 2);
    assert.equal(health.epg.currentOrFutureProgrammes, 4);
    assert.equal(health.mapping.matchedIds, 2);
    assert.ok(health.storage.activeVersion);
    // The guide itself is perfect, and the slug is still reported as degraded:
    // nothing is scheduled to renew it, so this exact payload is what a guide
    // that later expires looks like on the day it was published.
    assert.equal(health.epg.freshness, 'fresh');
    assert.equal(health.refresh.enabled, false);
    assert.equal(health.status, 'degraded');
    assert.ok(health.warnings.some((warning) => warning.includes('Nothing is scheduled to renew')));
    // And it says when it will run out, so "eventually" has a number.
    assert.ok(health.expiry.at);
    assert.ok(health.expiry.inMs > 0);

    const serialized = JSON.stringify(health);
    assert.equal(/m3u8|\.invalid/.test(serialized), false, 'health payload must not echo playlist/stream URLs');
    assert.equal(serialized.includes('http://'), false);
  });

  test('a slug with auto-refresh enabled reports healthy and renewing', async () => {
    const store = memoryStore();
    await publishFiles(store, 'slug', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, hoursAhead: 48 }) });
    const { saveRefreshConfig } = await import('../shared/epg-service.js');
    const config = await saveRefreshConfig(store, { slug: 'slug', m3uUrl: 'http://example.invalid/list.m3u', intervalKey: '24h' });
    await store.set('refresh-config:slug', { ...config, lastRunAt: Date.now() - 60_000, lastRunStatus: 'ok' }, { ttlSeconds: null });

    const health = await assessPublishedHealth(store, 'slug');
    assert.equal(health.status, 'healthy');
    assert.equal(health.refresh.enabled, true);
    assert.equal(health.refresh.intervalKey, '24h');
    assert.ok(health.refresh.nextRunAt, 'the next scheduled refresh is reported');
  });

  test('an enabled config the scheduler never runs is flagged as overdue, not as healthy', async () => {
    const store = memoryStore();
    await publishFiles(store, 'stalled', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, hoursAhead: 48 }) });
    const { saveRefreshConfig } = await import('../shared/epg-service.js');
    const config = await saveRefreshConfig(store, { slug: 'stalled', m3uUrl: 'http://example.invalid/list.m3u', intervalKey: '6h' });
    // Last ran three days ago against a 6h interval: the schedule exists on
    // paper and nothing has executed it.
    await store.set('refresh-config:stalled', { ...config, lastRunAt: Date.now() - 3 * 24 * 60 * 60 * 1000 }, { ttlSeconds: null });

    const health = await assessPublishedHealth(store, 'stalled');
    assert.equal(health.refresh.enabled, true);
    assert.equal(health.status, 'degraded');
    assert.ok(health.warnings.some((warning) => warning.includes('has not run when it was due')));
  });

  test('reports missing for a slug that was never published', async () => {
    const health = await assessPublishedHealth(memoryStore(), 'never-published');
    assert.equal(health.status, 'missing');
    assert.equal(health.published, false);
  });

  test('reports invalid when storage is unreadable rather than pretending it is fine', async () => {
    const store = memoryStore();
    store.getStale = async () => { throw new Error('bindings are misconfigured'); };
    const health = await assessPublishedHealth(store, 'slug');
    assert.equal(health.status, 'missing');
    assert.ok(health.warnings[0].includes('Storage is not readable'));
  });

  test('reports the last-known-good availability after a second publish', async () => {
    const store = memoryStore();
    await publishFiles(store, 'slug', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, hoursAhead: 48 }) });
    await publishFiles(store, 'slug', { m3uContent: MINIMAL_M3U, xmlContent: buildGuide({ ids: IDS, hoursAhead: 72 }) });
    const health = await assessPublishedHealth(store, 'slug');
    assert.equal(health.storage.lastKnownGoodAvailable, true);
  });
});

describe('validation helpers', () => {
  test('body kinds are classified so an error page is never treated as a guide', () => {
    assert.equal(detectBodyKind('   '), 'empty');
    assert.equal(detectBodyKind('<?xml version="1.0"?><tv/>'), 'xml');
    assert.equal(detectBodyKind('<tv></tv>'), 'xml');
    assert.equal(detectBodyKind('<!DOCTYPE html><html></html>'), 'html');
    assert.equal(detectBodyKind('<html><body>nope</body></html>'), 'html');
    assert.equal(detectBodyKind('{"ok":false}'), 'json');
    assert.equal(detectBodyKind('plain text'), 'other');
  });

  test('XMLTV timestamps honour their UTC offset', () => {
    assert.equal(parseXmltvStamp('20260918120000 +1000'), Date.UTC(2026, 8, 18, 2, 0, 0));
    assert.equal(parseXmltvStamp('20260918120000 -0430'), Date.UTC(2026, 8, 18, 16, 30, 0));
    assert.equal(parseXmltvStamp('20260918120000'), Date.UTC(2026, 8, 18, 12, 0, 0));
    assert.ok(Number.isNaN(parseXmltvStamp('not-a-date')));
    assert.ok(Number.isNaN(parseXmltvStamp('')));
  });

  test('source labels keep the host and drop credential-bearing path/query', () => {
    assert.equal(safeSourceLabel('https://user:pass@epg.example.com/private/guide.xml?token=abc'), 'epg.example.com');
    assert.equal(safeSourceLabel('nonsense'), 'unknown-source');
  });

  test('slug fingerprints are stable and non-reversible', () => {
    assert.equal(slugHash('matt'), slugHash('matt'));
    assert.notEqual(slugHash('matt'), 'matt');
  });
});
