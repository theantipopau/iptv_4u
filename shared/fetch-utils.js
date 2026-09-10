// fetch/concurrency helpers built entirely on Web-standard APIs (fetch,
// AbortController, DecompressionStream) so they run unchanged on both
// Node (server.js) and the Cloudflare Workers runtime (functions/api/*.js).

export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTextMaybeGzip(url, timeoutMs = 15000) {
  const response = await fetchWithTimeout(url, { redirect: 'follow' }, timeoutMs);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);
  const isGzip =
    url.endsWith('.gz') ||
    response.headers.get('content-encoding') === 'gzip' ||
    (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);

  if (isGzip) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buffer]).stream().pipeThrough(ds);
    const decompressed = await new Response(stream).arrayBuffer();
    return new TextDecoder('utf-8').decode(decompressed);
  }

  return new TextDecoder('utf-8').decode(buffer);
}

export async function runWithConcurrency(items, limit, worker) {
  const results = [];
  const queue = [...items];
  const workers = [];

  async function runner() {
    while (queue.length > 0) {
      const item = queue.shift();
      const result = await worker(item);
      if (result) results.push(result);
    }
  }

  const count = Math.min(limit, items.length);
  for (let i = 0; i < count; i += 1) {
    workers.push(runner());
  }

  await Promise.all(workers);
  return results;
}
