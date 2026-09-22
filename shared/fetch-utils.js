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

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decodeAttr = (value) => value.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity]);

/**
 * Incremental XMLTV filter: feed it text in any chunking and it keeps only the
 * <channel>/<programme> elements for `wantedIds`, verbatim. Memory is bounded
 * by what's kept, not by the size of the guide — the point is to renew a few
 * hundred channels from multi-megabyte guides inside a Worker's memory limit.
 */
export function createGuideSubsetScanner(wantedIds) {
  const wanted = new Set(wantedIds);
  const kept = { channel: [], programme: [] };
  let buffer = '';

  function scan() {
    let pos = 0;
    while (true) {
      const c = buffer.indexOf('<channel', pos);
      const p = buffer.indexOf('<programme', pos);
      if (c === -1 && p === -1) {
        // Keep a short tail: it may hold the start of a tag split across chunks.
        buffer = buffer.slice(Math.max(pos, buffer.length - 12));
        return;
      }
      const name = p === -1 || (c !== -1 && c < p) ? 'channel' : 'programme';
      const start = name === 'channel' ? c : p;
      const after = buffer[start + name.length + 1];
      if (after === undefined) break;
      if (!/[\s>/]/.test(after)) {
        pos = start + 1;
        continue;
      }
      const openEnd = buffer.indexOf('>', start);
      if (openEnd === -1) break;
      let end;
      if (buffer[openEnd - 1] === '/') {
        end = openEnd + 1;
      } else {
        const close = buffer.indexOf(`</${name}>`, openEnd);
        if (close === -1) break;
        end = close + name.length + 3;
      }
      const openTag = buffer.slice(start, openEnd + 1);
      const attr = openTag.match(name === 'channel' ? /\sid\s*=\s*(["'])(.*?)\1/ : /\schannel\s*=\s*(["'])(.*?)\1/);
      if (attr && wanted.has(decodeAttr(attr[2]))) kept[name].push(buffer.slice(start, end));
      pos = end;
    }
    // An element is incomplete: keep it (from its start) for the next chunk.
    const c = buffer.indexOf('<channel', pos);
    const p = buffer.indexOf('<programme', pos);
    const pending = [c, p].filter((i) => i !== -1);
    buffer = buffer.slice(pending.length ? Math.min(...pending) : pos);
  }

  return {
    push(text) {
      buffer += text;
      scan();
    },
    finish() {
      scan();
      buffer = '';
      return {
        channelCount: kept.channel.length,
        programmeCount: kept.programme.length,
        xml: `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${kept.channel.join('\n')}\n${kept.programme.join('\n')}\n</tv>\n`
      };
    }
  };
}

// Streaming, so this cap is about download time rather than memory.
const MAX_SUBSET_SOURCE_BYTES = 200 * 1024 * 1024;

/**
 * Fetch an XMLTV guide (plain or gzip) and return only the wanted channels'
 * elements as a small XMLTV document, without ever holding the whole guide.
 */
export async function fetchGuideSubset(url, wantedIds, timeoutMs = 60000) {
  const response = await fetchWithTimeout(url, { redirect: 'follow', headers: { 'Accept-Encoding': 'identity' } }, timeoutMs);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstChunk = first.value || new Uint8Array(0);
  const isGzip = url.endsWith('.gz')
    || response.headers.get('content-encoding') === 'gzip'
    || (firstChunk.length > 2 && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b);

  let total = 0;
  const raw = new ReadableStream({
    start(controller) {
      if (firstChunk.length) controller.enqueue(firstChunk);
      if (first.done) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.length;
      if (total > MAX_SUBSET_SOURCE_BYTES) {
        reader.cancel().catch(() => {});
        controller.error(new Error(`${url} exceeded ${MAX_SUBSET_SOURCE_BYTES / (1024 * 1024)}MB while downloading.`));
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel().catch(() => {});
    }
  });

  const bytes = isGzip ? raw.pipeThrough(new DecompressionStream('gzip')) : raw;
  const scanner = createGuideSubsetScanner(wantedIds);
  const decoder = new TextDecoder('utf-8');
  const textReader = bytes.getReader();
  while (true) {
    const { done, value } = await textReader.read();
    if (done) break;
    scanner.push(decoder.decode(value, { stream: true }));
  }
  scanner.push(decoder.decode());
  return scanner.finish();
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
