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

// Cloudflare Workers have a hard per-isolate memory ceiling (~128MB) —
// a large XMLTV guide parses into an in-memory object graph several
// times the size of its raw bytes, so a 50MB+ guide crashes the whole
// Worker invocation outright (opaque Cloudflare error 1102) rather than
// failing the one request that triggered it. Node has far more headroom
// and would handle this fine, but the cap is applied on both platforms
// for one consistent, predictable limit rather than one that silently
// depends on which backend happens to be running.
const MAX_FETCH_BYTES = 15 * 1024 * 1024;

async function readWithSizeLimit(response, url) {
  // Content-Length can be absent (chunked responses) or simply wrong, so
  // the real enforcement has to happen while streaming, not just as an
  // upfront header check.
  const reader = response.body?.getReader();
  if (!reader) {
    // No streaming body support — fall back to a single read (still
    // bounded by the Content-Length check the caller already did).
    return new Uint8Array(await response.arrayBuffer());
  }

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_FETCH_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error(`${url} exceeded the ${(MAX_FETCH_BYTES / (1024 * 1024)).toFixed(0)}MB size limit while downloading.`);
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
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

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_FETCH_BYTES) {
    throw new Error(`${url} is too large to process (${(declaredLength / (1024 * 1024)).toFixed(1)}MB, limit is ${(MAX_FETCH_BYTES / (1024 * 1024)).toFixed(0)}MB).`);
  }

  const buffer = await readWithSizeLimit(response, url);
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
