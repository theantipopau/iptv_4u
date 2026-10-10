// Write-route admin token and refresh-config URL checks. Both guard live
// behaviour: the token is opt-in (no token configured = no check), and the
// URL check must keep accepting the plain-http guide the nightly renewal uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAdmin } from '../shared/core.js';
import { saveRefreshConfig } from '../shared/epg-service.js';
import { memoryStore } from './fixtures.mjs';

test('assertAdmin does nothing while no token is configured', () => {
  assert.doesNotThrow(() => assertAdmin(undefined, ''));
  assert.doesNotThrow(() => assertAdmin(null, undefined));
});

test('assertAdmin accepts only the exact configured token', () => {
  assert.doesNotThrow(() => assertAdmin('s3cret-value', 's3cret-value'));
  assert.throws(() => assertAdmin('s3cret-valu3', 's3cret-value'), { code: 'ADMIN_TOKEN_INVALID', status: 401 });
  assert.throws(() => assertAdmin('s3cret', 's3cret-value'), { code: 'ADMIN_TOKEN_INVALID', status: 401 });
  assert.throws(() => assertAdmin(undefined, 's3cret-value'), { code: 'ADMIN_TOKEN_REQUIRED', status: 401 });
});

test('saveRefreshConfig keeps http and https sources and rejects anything else', async () => {
  const store = memoryStore();
  await assert.doesNotReject(saveRefreshConfig(store, {
    slug: 'url-check',
    m3uUrl: 'https://example.com/list.m3u',
    customGuideUrl: 'http://example.com/guide.xml',
    intervalKey: '12h'
  }));
  await assert.rejects(saveRefreshConfig(store, { slug: 'url-check', m3uUrl: 'ftp://example.com/list.m3u', intervalKey: '12h' }), /http:\/\/ or https:\/\//);
  await assert.rejects(saveRefreshConfig(store, {
    slug: 'url-check',
    m3uUrl: 'https://example.com/list.m3u',
    customGuideUrl: 'file:///etc/passwd',
    intervalKey: '12h'
  }), /custom guide URL/);
});
