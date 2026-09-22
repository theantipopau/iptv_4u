import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  discoverSources,
  parseFiles,
  searchChannel,
  mergeGuide,
  applyIdentity,
  exportM3u,
  publishFiles,
  getHostedFile,
  saveRefreshConfig,
  getRefreshConfig,
  runAutoRefresh,
  runDueAutoRefreshes,
  uploadLogoAsset,
  getLogoAsset,
  assessPublishedHealth,
  assessAllPublishedHealth
} from './shared/epg-service.js';
import { buildHostedResponse } from './shared/serve.js';
import { createNodeCache } from './shared/node-cache.js';
import { logEvent } from './shared/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // no .env file — fine, env vars may already be set another way
  }
}
loadDotEnv();

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const PORT = process.env.PORT || 3000;

// Storage locations are overridable so a deployment (or the integration
// tests) can point them somewhere else without editing this file; the
// defaults stay exactly where they've always been.
const cache = createNodeCache(process.env.IPTV4U_CACHE_DIR || path.join(__dirname, '.epg-cache'));
const hostedStore = createNodeCache(process.env.IPTV4U_HOSTED_DIR || path.join(__dirname, '.hosted-files'));

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  // Same baseline header the Worker sends on every response.
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
// extensions: '/watch' -> watch.html, matching Cloudflare's static-asset handling.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function handle(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req);
      res.json({ ok: true, ...result });
    } catch (error) {
      // Stage-specific diagnostics, never a bare 500 with an opaque message:
      // the UI (and anyone reading a log) needs to know which stage failed.
      res.status(error.status || 500).json({
        ok: false,
        error: error.message,
        code: error.code || 'INTERNAL_ERROR',
        details: error.details || undefined
      });
    }
  };
}

app.get('/api/discover-sources', handle(async (req) => {
  const force = req.query.refresh === '1';
  return discoverSources(cache, force);
}));

app.post('/api/parse-files', handle(async (req) => parseFiles(req.body)));

app.post('/api/search-channel', handle(async (req) => searchChannel(cache, TMDB_API_KEY, req.body)));

app.post('/api/merge-guide', handle(async (req) => mergeGuide(req.body)));

app.post('/api/apply-identity', handle(async (req) => applyIdentity(req.body)));

app.post('/api/export-m3u', handle(async (req) => exportM3u(req.body)));

app.post('/api/publish', handle(async (req) => publishFiles(hostedStore, req.body.slug, req.body)));

// Published files are served through the same shared layer the Cloudflare
// Worker uses (shared/serve.js): identical status codes, content types,
// cache headers and last-known-good fallback on both platforms.
function sendHosted(kind) {
  return async (req, res) => {
    const response = await buildHostedResponse(hostedStore, String(req.params.slug || ''), kind, {
      method: req.method
    });
    res.status(response.status);
    for (const [name, value] of Object.entries(response.headers)) res.set(name, value);
    if (response.body === null) return res.end();
    res.send(response.body);
  };
}

app.get('/iptv/:slug.m3u', sendHosted('playlist'));
app.head('/iptv/:slug.m3u', sendHosted('playlist'));

app.get('/epg/:slug.xml', sendHosted('epg'));
app.head('/epg/:slug.xml', sendHosted('epg'));

// Diagnostic endpoint: everything the UI (or a human with curl) needs to tell
// whether a published pair is healthy, without exposing stream URLs or
// credentials. Same shape on Express and Cloudflare.
app.get('/api/health/epg', handle(async () => assessAllPublishedHealth(hostedStore)));

app.get('/api/health/epg/:slug', handle(async (req) => assessPublishedHealth(hostedStore, req.params.slug)));

app.post('/api/upload-logo', handle(async (req) => uploadLogoAsset(hostedStore, req.body)));

app.get('/logo/:id', async (req, res) => {
  const asset = await getLogoAsset(hostedStore, req.params.id);
  if (!asset) return res.status(404).type('text/plain').send('Not found.');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(asset.contentType).send(Buffer.from(asset.imageBase64, 'base64'));
});

app.post('/api/refresh-config', handle(async (req) => ({ config: await saveRefreshConfig(hostedStore, req.body) })));

app.get('/api/refresh-config/:slug', handle(async (req) => ({ config: await getRefreshConfig(hostedStore, req.params.slug) })));

app.post('/api/refresh-now', handle(async (req) => {
  const config = await getRefreshConfig(hostedStore, req.body.slug);
  if (!config) {
    const error = new Error('No auto-refresh config saved for this slug yet — save one first.');
    error.status = 404;
    error.code = 'REFRESH_CONFIG_NOT_FOUND';
    throw error;
  }
  return { config: await runAutoRefresh(cache, hostedStore, TMDB_API_KEY, config, { selfHosts: [...LOCAL_HOSTS, req.hostname] }) };
}));

// ---- local auto-refresh scheduler ------------------------------------------
//
// Cloudflare's cron trigger drives auto-refresh in production, but nothing
// drove it locally: a saved config on a self-hosted/Express deployment was
// never executed by anything, so its guide silently aged out exactly like a
// slug with no config at all. Same tick, same due-check, same code path as
// the Worker — only the timer is different.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', ...String(process.env.IPTV4U_SELF_HOSTNAMES || '').split(',').map((h) => h.trim()).filter(Boolean)];

const AUTO_REFRESH_TICK_MS = Number(process.env.IPTV4U_REFRESH_TICK_MS || 60 * 60 * 1000);

/**
 * Start the periodic auto-refresh tick. Overlapping ticks are skipped rather
 * than queued, so a slow lineup can't pile up concurrent runs against the
 * same store. Returns a stop function.
 * @returns {() => void}
 */
export function startAutoRefreshScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueAutoRefreshes(cache, hostedStore, TMDB_API_KEY, { selfHosts: LOCAL_HOSTS });
    } catch (error) {
      logEvent('epg.autoRefresh.tick.failed', { errorCode: error.code || null, error: error.message }, 'error');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, AUTO_REFRESH_TICK_MS);
  // Never hold the process open just to wait for a tick.
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

export { app };

if (!process.env.IPTV4U_NO_LISTEN) {
  app.listen(PORT, () => {
    console.log(`IPTV 4U running on http://localhost:${PORT}`);
    if (!TMDB_API_KEY) {
      console.log('TMDB_API_KEY not set — 24/7 channel art lookup will be skipped (see .env.example).');
    }
  });
  if (process.env.IPTV4U_NO_SCHEDULER !== '1') {
    startAutoRefreshScheduler();
    console.log(`Auto-refresh scheduler running (checking every ${Math.round(AUTO_REFRESH_TICK_MS / 60000)} minutes; set IPTV4U_NO_SCHEDULER=1 to disable).`);
  }
}
