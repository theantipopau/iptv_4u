import { publishFiles } from '../../shared/epg-service.js';
import { createKvCache } from '../_lib/kv-cache.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const store = createKvCache(env.HOSTED_FILES);
    const result = await publishFiles(store, body.slug, body);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: error.status || 500 });
  }
}
