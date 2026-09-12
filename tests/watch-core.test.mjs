import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseM3U,
  channelKey,
  parseXmltvDate,
  parseGuideForNowNext,
  getNowNext,
  getUpcoming,
  pushRecent,
  pruneStaleKeys,
  isMixedContentCandidate,
  buildHttpsUpgradeUrl,
  redactUrl,
  redactHost,
  classifyStreamType,
  classifyPlaybackError
} from '../public/watch-core.js';

describe('parseM3U', () => {
  test('parses attrs and name', () => {
    const channels = parseM3U('#EXTM3U\n#EXTINF:-1 tvg-id="ESPN.us" tvg-chno="101",ESPN\nhttp://example.com/espn.m3u8\n');
    assert.equal(channels.length, 1);
    assert.equal(channels[0].name, 'ESPN');
    assert.equal(channels[0].attrs['tvg-id'], 'ESPN.us');
    assert.equal(channels[0].attrs['tvg-chno'], '101');
    assert.equal(channels[0].url, 'http://example.com/espn.m3u8');
  });
});

describe('channelKey', () => {
  test('prefers tvg-id over name', () => {
    assert.equal(channelKey({ attrs: { 'tvg-id': 'X.us' }, name: 'Fallback' }), 'X.us');
  });
  test('falls back to name when tvg-id is absent', () => {
    assert.equal(channelKey({ attrs: {}, name: 'Fallback' }), 'Fallback');
  });
});

describe('parseXmltvDate', () => {
  test('parses a UTC-offset timestamp correctly', () => {
    const d = parseXmltvDate('20260912040000 +0700');
    // 04:00 +0700 == 21:00 UTC the previous day
    assert.equal(d.toISOString(), '2026-09-11T21:00:00.000Z');
  });
  test('treats a missing offset as UTC', () => {
    const d = parseXmltvDate('20260912040000');
    assert.equal(d.toISOString(), '2026-09-12T04:00:00.000Z');
  });
  test('handles a negative offset (e.g. US Eastern)', () => {
    const d = parseXmltvDate('20260912040000 -0400');
    assert.equal(d.toISOString(), '2026-09-12T08:00:00.000Z');
  });
  test('returns null for malformed input', () => {
    assert.equal(parseXmltvDate('not-a-date'), null);
    assert.equal(parseXmltvDate(''), null);
    assert.equal(parseXmltvDate(undefined), null);
  });
});

describe('parseGuideForNowNext', () => {
  const xml = `<?xml version="1.0"?>
<tv>
  <channel id="ESPN.us"><display-name>ESPN</display-name></channel>
  <programme start="20260912040000 +0000" stop="20260912050000 +0000" channel="ESPN.us">
    <title>Real Show &amp; Stuff</title>
  </programme>
  <programme start="20260912050000 +0000" channel="ESPN.us">
    <title>No Stop Time Show</title>
  </programme>
  <programme start="20260912010000 +0000" stop="20260913010000 +0000" channel="STUB.us">
    <title>24/7 Placeholder</title>
    <category>24/7</category>
  </programme>
</tv>`;

  test('extracts programmes keyed by channel id, sorted by start', () => {
    const guide = parseGuideForNowNext(xml);
    const list = guide.get('ESPN.us');
    assert.equal(list.length, 2);
    assert.equal(list[0].title, 'Real Show & Stuff');
    assert.equal(list[1].title, 'No Stop Time Show');
    assert.equal(list[1].stop, null);
  });

  test('flags a synthesized 24/7 placeholder via its <category> marker', () => {
    const guide = parseGuideForNowNext(xml);
    const stub = guide.get('STUB.us');
    assert.equal(stub[0].isPlaceholder, true);
    assert.equal(guide.get('ESPN.us')[0].isPlaceholder, false);
  });

  test('returns an empty map for empty/garbage input', () => {
    assert.equal(parseGuideForNowNext('').size, 0);
    assert.equal(parseGuideForNowNext('not xml at all').size, 0);
  });
});

describe('getNowNext', () => {
  const guide = new Map([
    ['CH1', [
      { start: new Date('2026-09-12T04:00:00Z'), stop: new Date('2026-09-12T05:00:00Z'), title: 'Show A' },
      { start: new Date('2026-09-12T05:00:00Z'), stop: new Date('2026-09-12T06:00:00Z'), title: 'Show B' },
      { start: new Date('2026-09-12T06:00:00Z'), stop: null, title: 'Show C (open-ended)' }
    ]]
  ]);

  test('finds the programme spanning "now"', () => {
    const now = new Date('2026-09-12T04:30:00Z');
    const { current, next } = getNowNext(guide, 'CH1', now);
    assert.equal(current.title, 'Show A');
    assert.equal(next.title, 'Show B');
  });

  test('falls back to the next programme\'s start as the effective stop when stop is missing, except for the final open-ended entry', () => {
    const now = new Date('2026-09-12T06:30:00Z');
    const { current, next } = getNowNext(guide, 'CH1', now);
    assert.equal(current.title, 'Show C (open-ended)');
    assert.equal(next, null);
  });

  test('returns only "next" when now is before the first programme', () => {
    const now = new Date('2026-09-12T03:00:00Z');
    const { current, next } = getNowNext(guide, 'CH1', now);
    assert.equal(current, null);
    assert.equal(next.title, 'Show A');
  });

  test('returns nulls for a channel with no guide data', () => {
    const { current, next } = getNowNext(guide, 'UNKNOWN.us', new Date());
    assert.equal(current, null);
    assert.equal(next, null);
  });
});

describe('getUpcoming', () => {
  const guide = new Map([
    ['CH1', [
      { start: new Date('2026-09-12T04:00:00Z'), stop: new Date('2026-09-12T05:00:00Z'), title: 'A' },
      { start: new Date('2026-09-12T05:00:00Z'), stop: new Date('2026-09-12T06:00:00Z'), title: 'B' },
      { start: new Date('2026-09-12T06:00:00Z'), stop: new Date('2026-09-12T07:00:00Z'), title: 'C' }
    ]]
  ]);

  test('returns the current programme plus up to `count` after it', () => {
    const list = getUpcoming(guide, 'CH1', new Date('2026-09-12T04:30:00Z'), 2);
    assert.deepEqual(list.map((p) => p.title), ['A', 'B']);
  });
});

describe('pushRecent', () => {
  test('moves a re-watched channel to the front without duplicating it', () => {
    const result = pushRecent(['b', 'a', 'c'], 'a');
    assert.deepEqual(result, ['a', 'b', 'c']);
  });
  test('caps the list at `max`', () => {
    const result = pushRecent(['a', 'b', 'c'], 'd', 2);
    assert.deepEqual(result, ['d', 'a']);
  });
});

describe('pruneStaleKeys', () => {
  test('drops keys no longer present after a republish', () => {
    const result = pruneStaleKeys(['a', 'b', 'c'], new Set(['a', 'c']));
    assert.deepEqual(result, ['a', 'c']);
  });
});

describe('mixed content / https upgrade', () => {
  test('flags http-on-https as a mixed content candidate', () => {
    assert.equal(isMixedContentCandidate('https:', 'http://example.com/stream.m3u8'), true);
  });
  test('does not flag https streams, or http pages', () => {
    assert.equal(isMixedContentCandidate('https:', 'https://example.com/stream.m3u8'), false);
    assert.equal(isMixedContentCandidate('http:', 'http://example.com/stream.m3u8'), false);
  });
  test('builds an https-upgraded URL preserving path and query string', () => {
    assert.equal(
      buildHttpsUpgradeUrl('http://example.com:8080/stream/1?token=abc123'),
      'https://example.com:8080/stream/1?token=abc123'
    );
  });
  test('returns null for a non-http URL (never mutates a stored https url)', () => {
    assert.equal(buildHttpsUpgradeUrl('https://example.com/stream.m3u8'), null);
  });
});

describe('redaction', () => {
  test('strips query string, keeping scheme/host/path', () => {
    assert.equal(
      redactUrl('http://provider.example:8000/live/user123/pass456/998877?token=secret'),
      'http://provider.example:8000/live/user123/pass456/998877'
    );
  });
  test('strips anything after ? or # even for a malformed/non-absolute value', () => {
    assert.equal(redactUrl('not a url?token=secret'), 'not a url');
  });
  test('redactHost returns only the hostname', () => {
    assert.equal(redactHost('http://provider.example:8000/live/x?token=secret'), 'provider.example');
  });
});

describe('classifyStreamType', () => {
  test('prefers content-type over extension', () => {
    assert.equal(classifyStreamType('http://x/stream.ts', 'application/vnd.apple.mpegurl'), 'hls');
  });
  test('falls back to extension when content-type is unavailable', () => {
    assert.equal(classifyStreamType('http://x/stream.m3u8', ''), 'hls');
    assert.equal(classifyStreamType('http://x/stream.ts', ''), 'mpegts');
    assert.equal(classifyStreamType('http://x/unknown-path', ''), 'unknown');
  });
  test('recognizes an HTML error page returned instead of media', () => {
    assert.equal(classifyStreamType('http://x/stream.m3u8', 'text/html; charset=utf-8'), 'not-media');
  });
});

describe('classifyPlaybackError', () => {
  test('an upgrade-attempt failure is HTTPS_UPGRADE_FAILED, not "offline"', () => {
    const { category } = classifyPlaybackError({ source: 'hls', detail: 'manifestLoadError', isUpgradeAttempt: true });
    assert.equal(category, 'HTTPS_UPGRADE_FAILED');
  });
  test('a watchdog timeout is LOAD_TIMEOUT', () => {
    const { category } = classifyPlaybackError({ source: 'watchdog' });
    assert.equal(category, 'LOAD_TIMEOUT');
  });
  test('an hls.js codec error is MEDIA_DECODE_ERROR, not CORS', () => {
    const { category } = classifyPlaybackError({ source: 'hls', detail: 'bufferAddCodecError' });
    assert.equal(category, 'MEDIA_DECODE_ERROR');
  });
  test('a 403 response is AUTH_EXPIRED regardless of player source', () => {
    const { category } = classifyPlaybackError({ source: 'hls', detail: 'manifestLoadError', httpStatus: 403 });
    assert.equal(category, 'AUTH_EXPIRED');
  });
  test('an unrecognized detail code falls back to UNKNOWN, not a guess', () => {
    const { category } = classifyPlaybackError({ source: 'hls', detail: 'somethingNew' });
    assert.equal(category, 'UNKNOWN');
  });
  test('native MediaError codes map to network vs decode categories', () => {
    assert.equal(classifyPlaybackError({ source: 'native', detail: 2 }).category, 'MEDIA_NETWORK_ERROR');
    assert.equal(classifyPlaybackError({ source: 'native', detail: 3 }).category, 'MEDIA_DECODE_ERROR');
    assert.equal(classifyPlaybackError({ source: 'native', detail: 4 }).category, 'MEDIA_DECODE_ERROR');
  });
  test('autoplay rejection is a distinct, non-alarming category', () => {
    const { category, message } = classifyPlaybackError({ source: 'autoplay' });
    assert.equal(category, 'AUTOPLAY_BLOCKED');
    assert.match(message, /Tap Play/);
  });
});
