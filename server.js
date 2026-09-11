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
  runAutoRefresh
} from './shared/epg-service.js';
import { createNodeCache } from './shared/node-cache.js';

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

const cache = createNodeCache(path.join(__dirname, '.epg-cache'));
const hostedStore = createNodeCache(path.join(__dirname, '.hosted-files'));

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function handle(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: error.message });
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

app.get('/iptv/:slug.m3u', async (req, res) => {
  const content = await getHostedFile(hostedStore, req.params.slug, 'm3u');
  if (!content) return res.status(404).type('text/plain').send('Not found. Publish this playlist first.');
  res.type('audio/x-mpegurl').send(content);
});

app.get('/epg/:slug.xml', async (req, res) => {
  const content = await getHostedFile(hostedStore, req.params.slug, 'xml');
  if (!content) return res.status(404).type('text/plain').send('Not found. Publish this guide first.');
  res.type('application/xml').send(content);
});

app.post('/api/refresh-config', handle(async (req) => ({ config: await saveRefreshConfig(hostedStore, req.body) })));

app.get('/api/refresh-config/:slug', handle(async (req) => ({ config: await getRefreshConfig(hostedStore, req.params.slug) })));

app.post('/api/refresh-now', handle(async (req) => {
  const config = await getRefreshConfig(hostedStore, req.body.slug);
  if (!config) throw new Error('No auto-refresh config saved for this slug yet — save one first.');
  return { config: await runAutoRefresh(cache, hostedStore, TMDB_API_KEY, config) };
}));

app.listen(PORT, () => {
  console.log(`IPTV 4U running on http://localhost:${PORT}`);
  if (!TMDB_API_KEY) {
    console.log('TMDB_API_KEY not set — 24/7 channel art lookup will be skipped (see .env.example).');
  }
});
