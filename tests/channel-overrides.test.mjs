import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createNodeCache } from '../shared/node-cache.js';
import { publishFiles, getChannelOverrides, getHostedFile } from '../shared/epg-service.js';
import { MINIMAL_M3U } from './fixtures.mjs';

// Auto-refresh re-matches every channel from scratch on every scheduled
// run — these tests cover the storage contract that lets a manually
// confirmed match survive that (see runAutoRefresh in shared/epg-service.js
// for where getChannelOverrides is actually consulted; that half needs a
// live m3uUrl to fetch and is covered by manual end-to-end verification
// instead of a unit test here).

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv4u-overrides-test-'));
  return createNodeCache(dir);
}

describe('publishFiles + getChannelOverrides', () => {
  test('overrides published alongside a file round-trip correctly', async () => {
    const store = tempStore();
    const overrides = {
      'Weird Channel Name': {
        channelId: 'manual-id',
        channelName: 'Manual Name',
        source: 'manual',
        logoUrl: 'https://example.com/logo.png',
        guideUrl: null,
        canMergeGuide: false,
        tmdb: null,
        synthesize: false,
        score: null,
        manual: true
      }
    };

    await publishFiles(store, 'test-slug', { m3uContent: MINIMAL_M3U, overrides });

    const read = await getChannelOverrides(store, 'test-slug');
    assert.deepEqual(read, overrides);
  });

  test('publishing with no overrides leaves previously-saved overrides untouched', async () => {
    // runAutoRefresh's own re-publish call omits `overrides` entirely so
    // it doesn't wipe the set it just used — this is the behavior that
    // guarantees that.
    const store = tempStore();
    const overrides = { A: { channelId: 'a', manual: true } };
    await publishFiles(store, 'test-slug', { m3uContent: MINIMAL_M3U, overrides });
    const updated = `${MINIMAL_M3U}#updated\n`;
    await publishFiles(store, 'test-slug', { m3uContent: updated });

    const read = await getChannelOverrides(store, 'test-slug');
    assert.deepEqual(read, overrides);
    const m3u = await getHostedFile(store, 'test-slug', 'm3u');
    assert.match(m3u, /#updated/);
  });

  test('publishing an explicit empty overrides object clears previously-saved overrides', async () => {
    // A deliberate publish-time snapshot: if nothing is manual anymore,
    // nothing should still be protected from the next auto-refresh.
    const store = tempStore();
    await publishFiles(store, 'test-slug', { m3uContent: MINIMAL_M3U, overrides: { A: { channelId: 'a', manual: true } } });
    await publishFiles(store, 'test-slug', { m3uContent: MINIMAL_M3U, overrides: {} });

    const read = await getChannelOverrides(store, 'test-slug');
    assert.deepEqual(read, {});
  });

  test('getChannelOverrides returns an empty object for a slug with none saved', async () => {
    const store = tempStore();
    await publishFiles(store, 'test-slug', { m3uContent: MINIMAL_M3U });
    const read = await getChannelOverrides(store, 'test-slug');
    assert.deepEqual(read, {});
  });

  test('getChannelOverrides returns an empty object for an invalid slug', async () => {
    const store = tempStore();
    const read = await getChannelOverrides(store, '   ');
    assert.deepEqual(read, {});
  });
});
