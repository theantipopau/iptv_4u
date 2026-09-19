import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Structural guards for the onboarding that exists so a healthy published guide
// can't quietly have no renewal schedule. These assert the pieces are present
// and wired — the behaviour itself is covered by the API-level tests
// (guide-freshness, routes); what these catch is the onboarding being removed
// or the interval defaulting back to the dangerous value.

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

describe('publish onboarding', () => {
  test('the refresh interval defaults to a real interval, never to Off', () => {
    const start = html.indexOf('id="autoRefreshInterval"');
    assert.notEqual(start, -1, 'the interval selector must exist');
    const select = html.slice(start, html.indexOf('</select>', start));
    const selected = select.match(/<option value="([^"]*)"[^>]*\sselected/);
    assert.ok(selected, 'exactly one option must be pre-selected, so saving a config always has an interval');
    assert.notEqual(selected[1], '', 'defaulting to Off stored a config that could never run, while reporting success');
    assert.ok(['6h', '12h', '24h'].includes(selected[1]));
  });

  test('Off is labelled as what it actually means', () => {
    assert.match(html, /<option value="">Off \(guide will expire\)<\/option>/);
  });

  test('the Publish panel offers one-click enable and a place to report back', () => {
    assert.match(html, /id="enableAutoRefreshBtn"/);
    assert.match(html, /id="publishSummary"[^>]*aria-live="polite"/);
    assert.match(html, /id="attentionBanner"[^>]*aria-live="polite"/);
    assert.match(app, /el\.enableAutoRefreshBtn\.addEventListener\('click'/);
  });

  test('a successful publish renders the checklist and checks what was stored', () => {
    assert.match(app, /renderPublishSummary\(\{ slug: result\.slug, health, warnings: result\.warnings \|\| \[\] \}\)/);
    assert.match(app, /const health = await checkPublishedHealth\(\{ quiet: true \}\)/);
  });

  test('the checklist states renewal, or says it will expire and offers the fix', () => {
    assert.match(app, /WILL EXPIRE/);
    assert.match(app, /This guide appears healthy but will eventually expire unless auto-refresh is enabled\./);
    assert.match(app, /Enable Auto Refresh Now/);
  });

  test('existing slugs are audited as the app loads, not only on request', () => {
    assert.ok(/checkAllGuides\(\{ quiet: true \}\)/.test(app));
    assert.match(app, /renderAttentionBanner/);
  });
});
