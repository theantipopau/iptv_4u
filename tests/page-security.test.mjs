import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Both pages share an origin with the admin token in localStorage. These pin
// the guarantees that make that acceptable: /watch executes only its own
// scripts plus two version-pinned, integrity-checked CDN builds; the admin page
// executes its own scripts and nothing else, and talks only to its own origin.
// A failure here means a dependency bump forgot a hash, a new CDN slipped in,
// or an inline handler reappeared — all of which a browser would silently
// block at runtime rather than report anywhere the tests can see.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function policy(html) {
  const meta = html.match(/<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/i);
  assert.ok(meta, 'the page must declare a Content-Security-Policy');
  const content = meta[0].match(/content="([^"]*)"/i);
  assert.ok(content, 'the CSP meta tag must carry a content attribute');
  const directives = new Map();
  for (const part of content[1].split(';')) {
    const [name, ...values] = part.trim().split(/\s+/).filter(Boolean);
    if (name) directives.set(name.toLowerCase(), values);
  }
  return directives;
}

function thirdPartyScripts(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc="(https?:\/\/[^"]+)"[^>]*>/gi)].map((match) => ({
    tag: match[0],
    src: match[1],
    origin: new URL(match[1]).origin
  }));
}

const PAGES = [
  {
    page: '/watch',
    html: read('public/watch.html'),
    scripts: [read('public/watch.js')],
    scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
    // Deliberately broad: a playlist names arbitrary provider hosts that the
    // player has to reach directly for manifests, segments and channel logos.
    connectSrc: null
  },
  {
    page: '/ (admin)',
    html: read('public/index.html'),
    scripts: [read('public/app.js'), read('public/ui.js')],
    scriptSrc: ["'self'"],
    // Every request the admin page makes goes to this origin's /api/*.
    connectSrc: ["'self'"]
  }
];

for (const { page, html, scripts, scriptSrc, connectSrc } of PAGES) {
  test(`${page} allows exactly the origins it loads scripts from`, () => {
    const directives = policy(html);
    assert.deepEqual(directives.get('default-src'), ["'self'"]);
    assert.deepEqual(
      [...(directives.get('script-src') || [])].sort(),
      [...scriptSrc].sort(),
      'script-src must list exactly the origins the page loads scripts from'
    );
    for (const banned of ["'unsafe-inline'", "'unsafe-eval'", '*']) {
      assert.equal(directives.get('script-src').includes(banned), false, `script-src must not allow ${banned}`);
    }
    assert.deepEqual(directives.get('object-src'), ["'none'"]);
    assert.deepEqual(directives.get('base-uri'), ["'none'"]);
  });

  test(`${page} allows the fonts and images it actually loads`, () => {
    const directives = policy(html);
    assert.ok((directives.get('style-src') || []).includes('https://fonts.googleapis.com'), 'the Google Fonts stylesheet must be allowed');
    assert.ok((directives.get('font-src') || []).includes('https://fonts.gstatic.com'), 'the font files must be allowed');
    assert.ok((directives.get('manifest-src') || []).includes("'self'"), 'manifest.webmanifest must be allowed');
    const img = directives.get('img-src') || [];
    assert.ok(img.includes('https:') && img.includes('http:'), 'logos and posters come from arbitrary provider/TMDB hosts');
    if (connectSrc) assert.deepEqual(directives.get('connect-src'), connectSrc);
  });

  test(`${page} has no inline event handlers, which the policy would silently block`, () => {
    assert.equal(/\son[a-z]+\s*=\s*["']/i.test(html), false, `${page} markup must not use inline on* handlers`);
    for (const source of scripts) {
      assert.equal(
        /\bon(?:error|click|load|change|input|submit)="[^"]*"/i.test(source),
        false,
        'generated markup must not use inline on* handlers'
      );
    }
  });
}

test('/watch pins and hashes every third-party script', () => {
  const scripts = thirdPartyScripts(PAGES[0].html);
  assert.equal(scripts.length, 2, 'the player loads hls.js and mpegts.js from CDNs');
  for (const { tag, src, origin } of scripts) {
    assert.match(tag, /\bintegrity="sha(384|512)-[A-Za-z0-9+/]+={0,2}"/, `${origin} script needs a Subresource Integrity hash`);
    assert.match(tag, /\bcrossorigin="anonymous"/, 'SRI on a cross-origin script only applies with crossorigin');
    assert.match(src, /\d+\.\d+\.\d+/, 'the URL must pin an exact version, never a range or @latest');
  }
  assert.deepEqual(
    [...new Set(scripts.map((script) => script.origin))].sort(),
    ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com']
  );
});

test('the admin page loads no third-party scripts at all', () => {
  assert.deepEqual(thirdPartyScripts(PAGES[1].html), []);
});
