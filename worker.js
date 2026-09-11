// Entry point for Cloudflare's unified "Worker with static assets" model
// (what "Connect to Git" actually creates now — not classic Pages
// Functions, which never got wired up here since that per-file /functions
// routing convention doesn't apply to this resource type). One fetch
// handler routes /api/*, /iptv/*.m3u and /epg/*.xml, then falls back to
// env.ASSETS.fetch() for everything else (the public/ static site). A
// separate `scheduled` handler drives auto-refresh, triggered by the cron
// declared in wrangler.toml.
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
  getHostedFile,
  saveRefreshConfig,
  getRefreshConfig,
  runAutoRefresh,
  isRefreshDue
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

async function resolveTmdbApiKey(env) {
  // Secrets Store binding — an object with an async .get(), not a plain
  // string like the old (broken-on-GitHub-deploy) dashboard variable was.
  if (!env.TMDB_API_KEY) return '';
  try {
    return (await env.TMDB_API_KEY.get()) || '';
  } catch {
    return '';
  }
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
        return ok(await searchChannel(cache, await resolveTmdbApiKey(env), await readJson(request)));
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

      if (pathname === '/api/refresh-config' && request.method === 'POST') {
        const body = await readJson(request);
        return ok({ config: await saveRefreshConfig(hostedStore, body) });
      }

      const refreshConfigMatch = pathname.match(/^\/api\/refresh-config\/([^/]+)$/);
      if (refreshConfigMatch && request.method === 'GET') {
        return ok({ config: await getRefreshConfig(hostedStore, refreshConfigMatch[1]) });
      }

      if (pathname === '/api/refresh-now' && request.method === 'POST') {
        const body = await readJson(request);
        const config = await getRefreshConfig(hostedStore, body.slug);
        if (!config) throw new Error('No auto-refresh config saved for this slug yet — save one first.');
        return ok({ config: await runAutoRefresh(cache, hostedStore, await resolveTmdbApiKey(env), config) });
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
  },

  // Cloudflare Cron Triggers only support fixed schedules (not one per
  // user), so this fires on a fixed tick (see wrangler.toml) and checks
  // every saved config for whether it's actually due per its own
  // intervalKey — the standard pattern for per-resource intervals on top
  // of a shared cron.
  async scheduled(event, env, ctx) {
    const cache = createKvCache(env.EPG_CACHE);
    const hostedStore = createKvCache(env.HOSTED_FILES);

    ctx.waitUntil((async () => {
      const tmdbApiKey = await resolveTmdbApiKey(env);
      const list = await env.HOSTED_FILES.list({ prefix: 'refresh-config:' });
      for (const key of list.keys) {
        try {
          const raw = await env.HOSTED_FILES.get(key.name);
          if (!raw) continue;
          const config = JSON.parse(raw).data;
          if (!isRefreshDue(config)) continue;
          await runAutoRefresh(cache, hostedStore, tmdbApiKey, config);
        } catch (error) {
          console.error(`Auto-refresh failed for ${key.name}:`, error.message);
        }
      }
    })());
  }
};
