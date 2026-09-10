// Entry point for Cloudflare's unified "Worker with static assets" model
// (what "Connect to Git" actually creates now — not classic Pages
// Functions, which never got wired up here since that per-file /functions
// routing convention doesn't apply to this resource type). One fetch
// handler routes /api/*, /iptv/*.m3u and /epg/*.xml, then falls back to
// env.ASSETS.fetch() for everything else (the public/ static site).
//
// wrangler.toml declares `main = "worker.js"` and `[assets]` for this to
// actually get bundled and deployed as Worker logic instead of assets-only.

import {
  discoverSources,
  parseFiles,
  searchChannel,
  mergeGuide,
  applyIdentity,
  exportM3u,
  publishFiles,
  getHostedFile
} from './shared/epg-service.js';
import { createKvCache } from './shared/kv-cache.js';

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function ok(result) {
  return Response.json({ ok: true, ...result });
}

function fail(error) {
  return Response.json({ ok: false, error: error.message }, { status: error.status || 500 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const cache = createKvCache(env.EPG_CACHE);
    const hostedStore = createKvCache(env.HOSTED_FILES);

    try {
      if (pathname === '/api/discover-sources' && request.method === 'GET') {
        return ok(await discoverSources(cache, url.searchParams.get('refresh') === '1'));
      }

      if (pathname === '/api/parse-files' && request.method === 'POST') {
        return ok(await parseFiles(await readJson(request)));
      }

      if (pathname === '/api/search-channel' && request.method === 'POST') {
        return ok(await searchChannel(cache, env.TMDB_API_KEY || '', await readJson(request)));
      }

      if (pathname === '/api/merge-guide' && request.method === 'POST') {
        return ok(await mergeGuide(await readJson(request)));
      }

      if (pathname === '/api/apply-identity' && request.method === 'POST') {
        return ok(await applyIdentity(await readJson(request)));
      }

      if (pathname === '/api/export-m3u' && request.method === 'POST') {
        return ok(await exportM3u(await readJson(request)));
      }

      if (pathname === '/api/publish' && request.method === 'POST') {
        const body = await readJson(request);
        return ok(await publishFiles(hostedStore, body.slug, body));
      }

      const iptvMatch = pathname.match(/^\/iptv\/([^/]+)\.m3u$/i);
      if (iptvMatch && request.method === 'GET') {
        const content = await getHostedFile(hostedStore, iptvMatch[1], 'm3u');
        if (!content) return new Response('Not found. Publish this playlist first.', { status: 404 });
        return new Response(content, { headers: { 'Content-Type': 'audio/x-mpegurl' } });
      }

      const epgMatch = pathname.match(/^\/epg\/([^/]+)\.xml$/i);
      if (epgMatch && request.method === 'GET') {
        const content = await getHostedFile(hostedStore, epgMatch[1], 'xml');
        if (!content) return new Response('Not found. Publish this guide first.', { status: 404 });
        return new Response(content, { headers: { 'Content-Type': 'application/xml' } });
      }
    } catch (error) {
      return fail(error);
    }

    return env.ASSETS.fetch(request);
  }
};
