import { searchChannel } from '../../shared/epg-service.js';
import { createKvCache } from '../_lib/kv-cache.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const cache = createKvCache(env.EPG_CACHE);
    const result = await searchChannel(cache, env.TMDB_API_KEY || '', body);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: error.status || 500 });
  }
}
