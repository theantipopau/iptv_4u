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
  runDueAutoRefreshes,
  uploadLogoAsset,
  getLogoAsset,
  assessPublishedHealth,
  publicHealthReport,
  buildPublication,
  publicSlugId
} from './shared/epg-service.js';
import { buildHostedResponse } from './shared/serve.js';
import { createKvCache, createHostedKvStore } from './shared/kv-cache.js';
import { logEvent } from './shared/log.js';

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
  logEvent('api.request.failed', { errorCode: error.code || 'INTERNAL_ERROR', error: error.message }, 'error');
  return Response.json(
    { ok: false, error: error.message, code: error.code || 'INTERNAL_ERROR', details: error.details },
    { status: error.status || 500 }
  );
}

function fromHosted(result) {
  const headers = new Headers(result.headers);
  return new Response(result.body, { status: result.status, headers });
}

// Hostnames this Worker answers on (wrangler.toml [vars]). An auto-refresh
// source URL on one of these is read from storage, not fetched.
function selfHostnames(env) {
  return String(env.SELF_HOSTNAMES || '').split(',').map((host) => host.trim()).filter(Boolean);
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
    // The hosted store must never expire its values: it holds published
    // playlists/guides whose URLs players are permanently pointed at. Using
    // the cache TTL here was a real bug — publications silently vanished from
    // KV (and so 404'd) 30 days after they were written.
    const hostedStore = createHostedKvStore(env.HOSTED_FILES);

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

      if (pathname === '/api/build-from-plan' && request.method === 'POST') {
        return ok(await buildPublication(cache, await resolveTmdbApiKey(env), await readJson(request)));
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
        if (!config) {
          const error = new Error('No auto-refresh config saved for this slug yet — save one first.');
          error.status = 404;
          error.code = 'REFRESH_CONFIG_NOT_FOUND';
          throw error;
        }
        return ok({ config: await runAutoRefresh(cache, hostedStore, await resolveTmdbApiKey(env), config, {
          selfHosts: [...selfHostnames(env), url.hostname],
          requirePlan: true
        }) });
      }

      const iptvMatch = pathname.match(/^\/iptv\/([^/]+)\.m3u$/i);
      if (iptvMatch && (request.method === 'GET' || request.method === 'HEAD')) {
        return fromHosted(await buildHostedResponse(hostedStore, decodeURIComponent(iptvMatch[1]), 'playlist', { method: request.method }));
      }

      const epgMatch = pathname.match(/^\/epg\/([^/]+)\.xml$/i);
      if (epgMatch && (request.method === 'GET' || request.method === 'HEAD')) {
        return fromHosted(await buildHostedResponse(hostedStore, decodeURIComponent(epgMatch[1]), 'epg', { method: request.method }));
      }

      if (pathname === '/api/health/epg' && request.method === 'GET') {
        return ok(await publicHealthReport(hostedStore, { reveal: url.searchParams.get('slug') }));
      }

      const healthMatch = pathname.match(/^\/api\/health\/epg\/([^/]+)$/);
      if (healthMatch && request.method === 'GET') {
        const slug = decodeURIComponent(healthMatch[1]);
        return ok({ ...(await assessPublishedHealth(hostedStore, slug)), id: await publicSlugId(hostedStore, slug) });
      }

      if (pathname === '/api/upload-logo' && request.method === 'POST') {
        return ok(await uploadLogoAsset(hostedStore, await readJson(request)));
      }

      const logoMatch = pathname.match(/^\/logo\/([a-f0-9]{32})$/i);
      if (logoMatch && request.method === 'GET') {
        const asset = await getLogoAsset(hostedStore, logoMatch[1]);
        if (!asset) return new Response('Not found.', { status: 404 });
        const bytes = Uint8Array.from(atob(asset.imageBase64), (c) => c.charCodeAt(0));
        return new Response(bytes, {
          headers: {
            'Content-Type': asset.contentType,
            'Cache-Control': 'public, max-age=31536000, immutable'
          }
        });
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
    // createHostedKvStore (never expires), not createKvCache: the cron
    // re-publishes the playlist/guide, and through the cache adapter those
    // writes inherited a 30-day TTL — so even a working auto-refresh would
    // have let the published files silently expire.
    const hostedStore = createHostedKvStore(env.HOSTED_FILES);

    ctx.waitUntil((async () => {
      if (!env.HOSTED_FILES) {
        logEvent('epg.autoRefresh.storage.missing', { errorCode: 'STORAGE_BINDING_MISSING' }, 'error');
        return;
      }
      try {
        const tmdbApiKey = await resolveTmdbApiKey(env);
        // Shared with the local scheduler in server.js, so both runtimes
        // discover due work and report failures the same way.
        await runDueAutoRefreshes(cache, hostedStore, tmdbApiKey, { selfHosts: selfHostnames(env), requirePlan: true });
      } catch (error) {
        logEvent('epg.autoRefresh.failed', { errorCode: error.code || null, error: error.message }, 'error');
      }
    })());
  }
};
