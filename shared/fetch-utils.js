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
  // Ask the server not to transport-compress the response — we only want
  // to decompress genuinely pre-compressed static .gz files below, not
  // negotiate HTTP-level gzip. (That negotiated path, combined with
  // chunked transfer-encoding, has been observed to crash Node's
  // DecompressionStream outright — Accept-Encoding: identity sidesteps it
  // entirely rather than trying to work around the crash.)
  const response = await fetchWithTimeout(url, { redirect: 'follow', headers: { 'Accept-Encoding': 'identity' } }, timeoutMs);
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
    try {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([buffer]).stream().pipeThrough(ds);
      const decompressed = await new Response(stream).arrayBuffer();
      return new TextDecoder('utf-8').decode(decompressed);
    } catch {
      // Fall through and try decoding as plain text — better a possibly
      // garbled result than a hard failure on a source that turned out
      // not to need decompression after all.
    }
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
