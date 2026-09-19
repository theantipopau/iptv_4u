// Serving layer for published files, shared by server.js (Express) and
// worker.js (Cloudflare) so the two can't drift apart in status codes,
// content types or cache headers — the divergence that makes "works locally,
// broken in production" possible.
//
// Deliberately cheap: it reads the publication manifest's stored metadata for
// freshness/ETag rather than re-parsing a multi-megabyte guide on every
// request (a Worker serving a 5MB guide has a tight CPU budget, and a player
// polls this endpoint). Full validation happens at publish time and on demand
// via the health endpoint.

import { resolveHostedFile } from './epg-service.js';
import {
  looksLikeGuideContent,
  looksLikePlaylistContent,
  manifestFreshness,
  weakContentTag,
  slugHash,
  byteLength
} from './validate.js';
import { logEvent } from './log.js';
import { slugify } from './core.js';

// Kinds share one shape so routes only supply a name.
const KINDS = {
  playlist: {
    contentType: 'audio/x-mpegurl; charset=utf-8',
    // No "attachment" disposition: players fetch this as a playlist.
    label: 'playlist',
    missingCode: 'PLAYLIST_NOT_FOUND',
    missingError: 'Published playlist not found',
    isValid: looksLikePlaylistContent
  },
  epg: {
    contentType: 'application/xml; charset=utf-8',
    label: 'EPG',
    missingCode: 'EPG_NOT_FOUND',
    missingError: 'Published EPG not found',
    isValid: looksLikeGuideContent
  }
};

// Short and revalidating on purpose. Long-lived caching here means a republish
// isn't picked up for hours (and is a real way to make a fixed guide look
// broken); no caching at all makes a player re-download a multi-MB guide on
// every refresh. Five minutes plus an ETag balances both.
const CACHE_CONTROL = 'public, max-age=300, must-revalidate';

function jsonError(status, code, error, slug) {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: `${JSON.stringify({ ok: false, error, code, slug: slug ? slugify(slug) : null })}\n`
  };
}

/**
 * Build the HTTP response description for a hosted playlist/guide request.
 * The caller (Express or Worker) only has to apply it.
 *
 * @param {Object} store hosted store adapter
 * @param {string} slugInput
 * @param {'playlist'|'epg'} kind
 * @param {{now?: number, method?: string}} [options]
 * @returns {Promise<{status: number, headers: Record<string,string>, body: string|null, version: string|null, freshness: string|null, fallback: boolean}>}
 */
export async function buildHostedResponse(store, slugInput, kind, options = {}) {
  const now = options.now ?? Date.now();
  const method = (options.method || 'GET').toUpperCase();
  const config = KINDS[kind];
  if (!config) throw new Error(`Unknown hosted file kind: ${kind}`);
  const slug = slugify(slugInput);

  let current = null;
  try {
    current = await resolveHostedFile(store, slug, kind);
  } catch (error) {
    // A storage failure must never masquerade as "no content" or, worse, as a
    // successful empty response.
    logEvent('hosted.file.read.failed', { kind, errorCode: error.code || null, error: error.message }, 'error');
    return jsonError(503, 'STORAGE_UNAVAILABLE', 'Published files could not be read from storage.', slug);
  }

  if (!current) {
    logEvent(kind === 'epg' ? 'hosted.epg.missing' : 'hosted.playlist.missing', { slugHash: slugHash(slug) });
    return jsonError(404, config.missingCode, config.missingError, slug);
  }

  let content = current.content;
  let fallback = false;
  let version = current.version;
  const manifest = current.manifest || null;

  // Tripwire: if what's live is not even recognisably a playlist/guide, serve
  // the previous validated version instead of a corrupt document, and say so
  // in a header. A player showing yesterday's schedule beats a player showing
  // nothing (or showing an HTML error page as a guide).
  if (!config.isValid(content)) {
    const previousVersion = manifest?.previousVersion;
    let recovered = null;
    if (previousVersion) {
      try {
        recovered = await resolveHostedFile(store, slug, kind, { version: previousVersion });
      } catch { /* fall through to the explicit error below */ }
    }
    if (recovered && config.isValid(recovered.content)) {
      logEvent('hosted.epg.last_known_good_served', { kind, slugHash: slugHash(slug), version: previousVersion }, 'warn');
      content = recovered.content;
      version = previousVersion;
      fallback = true;
    } else {
      logEvent('hosted.epg.corrupt', { kind, version, errorCode: 'HOSTED_CONTENT_INVALID' }, 'error');
      return jsonError(503, 'HOSTED_CONTENT_INVALID', `The published ${config.label} is unreadable and no last-known-good version is available. Republish this slug.`, slug);
    }
  }

  const freshness = kind === 'epg' ? manifestFreshness(manifest, now) : null;
  // Versioned publications carry a stored content hash; older ones only get a
  // cheap change-detecting tag (see weakContentTag).
  const etagSource = manifest?.contentHashes?.[kind === 'playlist' ? 'playlist' : 'epg'] || weakContentTag(content);

  const headers = {
    'Content-Type': config.contentType,
    'Cache-Control': CACHE_CONTROL,
    ETag: `"${String(etagSource).slice(0, 32)}"`,
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding'
  };
  if (manifest?.publishedAt) headers['Last-Modified'] = new Date(manifest.publishedAt).toUTCString();
  if (version) headers['X-Hosted-Version'] = version;
  if (kind === 'epg') {
    if (freshness) headers['X-EPG-Freshness'] = freshness;
    if (manifest?.latestProgramStop) headers['X-EPG-Latest-Stop'] = manifest.latestProgramStop;
    if (manifest?.epgPrograms != null) headers['X-EPG-Programmes'] = String(manifest.epgPrograms);
    if (freshness === 'expired') headers['Warning'] = '110 - "Response is Stale"';
  }
  if (fallback) headers['X-Hosted-Fallback'] = 'last-known-good';

  if (method === 'HEAD') {
    // A HEAD response carries no body here (the caller ends the response), so
    // Content-Length has to be stated explicitly — players use it to decide
    // whether to fetch the document at all.
    headers['Content-Length'] = String(byteLength(content));
  }

  return {
    status: 200,
    headers,
    body: method === 'HEAD' ? null : content,
    version,
    freshness,
    fallback
  };
}

/**
 * Derived from a manifest alone, for the health endpoint's `storage` block.
 * @param {Object|null} manifest
 * @param {number} [now]
 */
export function describeManifest(manifest, now = Date.now()) {
  if (!manifest) return null;
  return {
    activeVersion: manifest.activeVersion || null,
    previousVersion: manifest.previousVersion || null,
    publishedAt: manifest.publishedAt || null,
    freshness: manifestFreshness(manifest, now),
    latestProgramStop: manifest.latestProgramStop || null,
    currentOrFutureProgrammes: manifest.epgCurrentOrFuturePrograms ?? null,
    identifierMatchCount: manifest.identifierMatchCount ?? null,
    warnings: manifest.warnings || []
  };
}

export { KINDS as HOSTED_FILE_KINDS };
