import { getHostedFile } from '../../shared/epg-service.js';
import { createKvCache } from '../_lib/kv-cache.js';

export async function onRequestGet({ params, env }) {
  const raw = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
  const match = raw.match(/^([^/]+)\.xml$/i);
  if (!match) {
    return new Response('Expected /epg/<slug>.xml', { status: 404 });
  }

  const store = createKvCache(env.HOSTED_FILES);
  const content = await getHostedFile(store, match[1], 'xml');
  if (!content) {
    return new Response('Not found. Publish this guide first.', { status: 404 });
  }

  return new Response(content, { headers: { 'Content-Type': 'application/xml' } });
}
