import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Durable Objects and Browser Run are usage-billed on Cloudflare; this
// project should stay on the free-friendly pieces (assets, KV, cron).
const FORBIDDEN = [
  /durable_objects/i,
  /new_sqlite_classes|new_classes/i,
  /\[\[migrations\]\]/i,
  /^\s*\[browser\]/im,
  /"browser"\s*:/i,
  /@cloudflare\/(puppeteer|playwright)/i,
  /\bpuppeteer\b/i
];

function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
}

for (const file of ['wrangler.toml', 'package.json']) {
  test(`${file} declares no usage-billed Cloudflare products`, () => {
    const text = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    for (const pattern of FORBIDDEN) {
      assert.equal(pattern.test(text), false, `${file} matches ${pattern}`);
    }
  });
}
