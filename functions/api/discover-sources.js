import { discoverSources } from '../../shared/epg-service.js';
import { createKvCache } from '../_lib/kv-cache.js';

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const force = url.searchParams.get('refresh') === '1';
    const cache = createKvCache(env.EPG_CACHE);
    const result = await discoverSources(cache, force);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: error.status || 500 });
  }
}
