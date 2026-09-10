import { getHostedFile } from '../../shared/epg-service.js';
import { createKvCache } from '../_lib/kv-cache.js';

export async function onRequestGet({ params, env }) {
  const raw = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
  const match = raw.match(/^([^/]+)\.m3u$/i);
  if (!match) {
    return new Response('Expected /iptv/<slug>.m3u', { status: 404 });
  }

  const store = createKvCache(env.HOSTED_FILES);
  const content = await getHostedFile(store, match[1], 'm3u');
  if (!content) {
    return new Response('Not found. Publish this playlist first.', { status: 404 });
  }

  return new Response(content, { headers: { 'Content-Type': 'audio/x-mpegurl' } });
}
