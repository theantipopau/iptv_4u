// Platform-agnostic validation for the two things that actually decide
// whether an IPTV player shows a guide at all:
//
//   1. The playlist <-> guide identity contract. TiViMate (and every other
//      player) joins an M3U channel to its XMLTV programmes by exact string
//      equality: M3U `tvg-id` === XMLTV `<channel id>` === XMLTV
//      `<programme channel>`. Both files can be individually well-formed and
//      still leave a player showing no EPG for a single channel if the ids
//      don't line up.
//   2. Guide freshness. An XMLTV guide is a *schedule*, so it is only useful
//      while it contains programmes that haven't finished yet. A published
//      guide whose every <programme> has already ended is still perfectly
//      valid XML, still serves as HTTP 200, and still produces "no EPG data"
//      in every player. That combination — 200 OK, valid XML, zero future
//      programmes — is what this module exists to catch.
//
// No fs, no Node built-ins, no Express, no Cloudflare APIs: this runs
// unchanged under server.js and worker.js, and is the single place
// publication decisions and health reporting are computed from.

import { arrify, parseM3U, parseXmlTv, stripInvalidXmlChars } from './core.js';

export { stripInvalidXmlChars };

// Conservative by default: these exist to stop catastrophic output reaching
// a player, not to gate normal partial coverage. Overridable per call so a
// future caller can tighten them without editing publishing logic.
export const VALIDATION_THRESHOLDS = {
  // A handful of programmes pointing at channel ids a source didn't declare
  // is a real-world upstream quirk, not a reason to refuse a publish.
  maxDanglingProgrammeReferences: 25,
  maxDanglingProgrammeRatio: 0.02,
  // Substantially fewer programmes than the previous publication, for the
  // same set of channels, is a strong "the sources half-failed" signal.
  minProgrammeRetentionRatio: 0.5,
  // Bodies below this are never a real playlist/guide.
  minPlaylistBytes: 16,
  minGuideBytes: 32
};

const XMLTV_STAMP_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-])(\d{2})(\d{2}))?$/;

/**
 * Parse an XMLTV timestamp (`YYYYMMDDHHMMSS ±HHMM`) into epoch milliseconds.
 * Returns NaN for anything malformed rather than throwing, so callers can
 * count invalid dates instead of aborting a whole-guide scan. The offset is
 * honoured (an offset-less timestamp is treated as UTC, which is what the
 * XMLTV convention of "+0000" means).
 * @param {string} value
 * @returns {number}
 */
export function parseXmltvStamp(value) {
  const match = XMLTV_STAMP_RE.exec(String(value || '').trim());
  if (!match) return NaN;
  const [, y, mo, d, h, mi, s, sign, offH, offM] = match;
  const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
  if (!sign) return base;
  const offsetMinutes = Number(offH) * 60 + Number(offM);
  return base - (sign === '-' ? -1 : 1) * offsetMinutes * 60000;
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Classify a fetched body before trusting it as a document. An HTML error
 * page or a JSON error object served with 200 is a very common upstream
 * failure mode, and it must never be cached or published as a guide.
 * @param {string} text
 * @returns {'empty'|'xml'|'html'|'json'|'other'}
 */
export function detectBodyKind(text) {
  const trimmed = String(text || '').replace(/^\uFEFF/, '').trimStart();
  if (!trimmed) return 'empty';
  if (/^<(!doctype\s+html|html)[\s>]/i.test(trimmed)) return 'html';
  if (/^[[{]/.test(trimmed)) {
    // Plausible JSON only if it actually parses — a plain-text body starting
    // with "[" (e.g. "[Error]") isn't worth calling JSON.
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      return 'other';
    }
  }
  if (/^<(\?xml|tv[\s>])/i.test(trimmed)) return 'xml';
  if (trimmed.startsWith('<')) return 'html';
  return 'other';
}

const DOUBLE_ESCAPED_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);(?:amp|lt|gt|quot|apos);/g;

/**
 * @typedef {Object} PlaylistAnalysis
 * @property {boolean} valid
 * @property {number} bytes
 * @property {number} channelCount
 * @property {number} channelsWithTvgId
 * @property {number} blankTvgIdCount
 * @property {string[]} ids                 unique, non-empty, in playlist order
 * @property {string[]} duplicateIds
 * @property {{code: string, message: string}[]} errors
 */

/**
 * @param {string} m3uContent
 * @returns {PlaylistAnalysis}
 */
export function analyzePlaylist(m3uContent) {
  const text = String(m3uContent || '');
  const errors = [];
  const channels = parseM3U(text);

  const ids = [];
  const seen = new Set();
  const duplicateIds = new Set();
  const idCounts = new Map();
  for (const channel of channels) {
    const id = (channel.attrs?.['tvg-id'] || '').trim();
    if (!id) continue;
    idCounts.set(id, (idCounts.get(id) || 0) + 1);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  for (const [id, count] of idCounts) if (count > 1) duplicateIds.add(id);

  if (!text.trim()) {
    errors.push({ code: 'PLAYLIST_EMPTY', message: 'The playlist is empty.' });
  } else if (channels.length === 0) {
    errors.push({ code: 'PLAYLIST_NO_CHANNELS', message: 'No channels were found in the playlist (expected #EXTINF entries).' });
  } else if (!/^#EXTM3U/.test(text.trimStart())) {
    errors.push({ code: 'PLAYLIST_BAD_HEADER', message: 'The playlist does not start with #EXTM3U.' });
  }

  return {
    valid: errors.length === 0,
    bytes: byteLength(text),
    channelCount: channels.length,
    channelsWithTvgId: ids.length,
    blankTvgIdCount: channels.length - ids.length,
    ids,
    duplicateIds: [...duplicateIds],
    errors
  };
}

/**
 * @typedef {Object} GuideAnalysis
 * @property {boolean} validXml
 * @property {'empty'|'xml'|'html'|'json'|'other'} bodyKind
 * @property {number} bytes
 * @property {number} channelCount
 * @property {number} uniqueChannelCount
 * @property {number} programmeCount
 * @property {number} danglingProgrammeReferences
 * @property {number} channelsWithoutProgrammes
 * @property {number} invalidProgrammeDates
 * @property {number} backwardsProgrammes
 * @property {number} expiredProgrammes
 * @property {number} currentOrFutureProgrammes
 * @property {string|null} earliestStart
 * @property {string|null} latestStop
 * @property {string[]} ids
 * @property {string[]} duplicateChannelIds
 * @property {string[]} programmeChannelIds
 * @property {{code: string, message: string}[]} errors
 * @property {{code: string, message: string}[]} warnings
 */

/**
 * @param {string} xmlContent
 * @param {{now?: number}} [options]
 * @returns {GuideAnalysis}
 */
export function analyzeGuide(xmlContent, options = {}) {
  const now = options.now ?? Date.now();
  const text = String(xmlContent || '');
  const bodyKind = detectBodyKind(text);
  const errors = [];
  const warnings = [];

  const analysis = {
    validXml: false,
    bodyKind,
    bytes: byteLength(text),
    channelCount: 0,
    uniqueChannelCount: 0,
    programmeCount: 0,
    danglingProgrammeReferences: 0,
    channelsWithoutProgrammes: 0,
    idsWithProgrammes: 0,
    invalidProgrammeDates: 0,
    backwardsProgrammes: 0,
    expiredProgrammes: 0,
    currentOrFutureProgrammes: 0,
    earliestStart: null,
    latestStop: null,
    ids: [],
    duplicateChannelIds: [],
    programmeChannelIds: [],
    errors,
    warnings
  };

  if (!text.trim()) {
    errors.push({ code: 'GUIDE_EMPTY', message: 'The guide is empty.' });
    return analysis;
  }
  if (bodyKind === 'html') {
    errors.push({ code: 'GUIDE_NOT_XML_HTML', message: 'The guide is an HTML document, not XMLTV (an error page was returned instead of a guide).' });
    return analysis;
  }
  if (bodyKind === 'json') {
    errors.push({ code: 'GUIDE_NOT_XML_JSON', message: 'The guide is a JSON document, not XMLTV.' });
    return analysis;
  }
  if (bodyKind !== 'xml') {
    errors.push({ code: 'GUIDE_NOT_XML', message: 'The guide does not look like XMLTV (no <?xml?> declaration or <tv> root).' });
    return analysis;
  }

  let parsed;
  try {
    parsed = parseXmlTv(text);
  } catch (error) {
    errors.push({ code: 'GUIDE_XML_PARSE_FAILED', message: `The guide could not be parsed as XML: ${error.message}` });
    return analysis;
  }
  analysis.validXml = true;

  const channelIds = parsed.channels.map((c) => (c.id || '').trim());
  const declared = new Set(channelIds.filter(Boolean));

  const counts = new Map();
  for (const id of channelIds) {
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  analysis.channelCount = channelIds.length;
  analysis.uniqueChannelCount = declared.size;
  analysis.ids = [...declared];
  analysis.duplicateChannelIds = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);

  const refs = [];
  const withProgrammes = new Set();
  let earliest = Infinity;
  let latest = -Infinity;

  for (const programme of arrify(parsed.programmes)) {
    const channelId = String(programme['@_channel'] || '').trim();
    refs.push(channelId);
    if (channelId) withProgrammes.add(channelId);

    const start = parseXmltvStamp(programme['@_start']);
    const stop = parseXmltvStamp(programme['@_stop']);
    if (Number.isNaN(start) || Number.isNaN(stop)) {
      analysis.invalidProgrammeDates += 1;
      continue;
    }
    if (stop <= start) analysis.backwardsProgrammes += 1;
    if (stop < now) analysis.expiredProgrammes += 1;
    else analysis.currentOrFutureProgrammes += 1;
    if (start < earliest) earliest = start;
    if (stop > latest) latest = stop;
  }

  analysis.programmeCount = refs.length;
  analysis.programmeChannelIds = [...new Set(refs)].slice(0, 500);
  analysis.danglingProgrammeReferences = refs.filter((id) => !id || !declared.has(id)).length;
  analysis.channelsWithoutProgrammes = [...declared].filter((id) => !withProgrammes.has(id)).length;
  analysis.idsWithProgrammes = [...declared].filter((id) => withProgrammes.has(id)).length;
  analysis.earliestStart = isoOrNull(earliest);
  analysis.latestStop = isoOrNull(latest);

  if (analysis.channelCount === 0) {
    errors.push({ code: 'GUIDE_NO_CHANNELS', message: 'The guide declares no <channel> entries.' });
  }
  if (analysis.channelCount > 0 && analysis.channelCount !== analysis.uniqueChannelCount) {
    warnings.push({
      code: 'GUIDE_DUPLICATE_CHANNEL_IDS',
      message: `${analysis.channelCount - analysis.uniqueChannelCount} duplicate <channel id> value(s) — players may bind programmes to the wrong entry.`
    });
  }
  if (analysis.danglingProgrammeReferences > 0) {
    const ratio = analysis.programmeCount ? analysis.danglingProgrammeReferences / analysis.programmeCount : 0;
    const entry = {
      code: 'GUIDE_DANGLING_PROGRAMMES',
      message: `${analysis.danglingProgrammeReferences} programme(s) reference a channel id that isn't declared by any <channel> node.`
    };
    if (ratio > VALIDATION_THRESHOLDS.maxDanglingProgrammeRatio && analysis.danglingProgrammeReferences > VALIDATION_THRESHOLDS.maxDanglingProgrammeReferences) {
      errors.push(entry);
    } else {
      warnings.push(entry);
    }
  }
  if (analysis.invalidProgrammeDates > 0) {
    warnings.push({
      code: 'GUIDE_INVALID_DATES',
      message: `${analysis.invalidProgrammeDates} programme(s) have an invalid start/stop timestamp and cannot be shown.`
    });
  }
  if (analysis.backwardsProgrammes > 0) {
    warnings.push({
      code: 'GUIDE_BACKWARDS_PROGRAMMES',
      message: `${analysis.backwardsProgrammes} programme(s) stop before they start.`
    });
  }
  const doubleEscaped = (text.match(DOUBLE_ESCAPED_ENTITY_RE) || []).length;
  if (doubleEscaped > 0) {
    warnings.push({
      code: 'GUIDE_DOUBLE_ESCAPED_ENTITIES',
      message: `${doubleEscaped} double-escaped XML entity reference(s) — titles may display as "&amp;lt;".`
    });
  }
  if (text.charCodeAt(0) === 0xfeff) {
    warnings.push({ code: 'GUIDE_BOM', message: 'The guide begins with a byte-order mark.' });
  }
  if (analysis.programmeCount > 0 && analysis.currentOrFutureProgrammes === 0) {
    errors.push({
      code: 'GUIDE_EXPIRED',
      message: `Every one of the ${analysis.programmeCount} programme(s) in this guide has already ended (latest stop ${analysis.latestStop}) — players will show no EPG at all.`
    });
  }
  if (analysis.channelCount > 0 && analysis.programmeCount === 0) {
    warnings.push({
      code: 'GUIDE_NO_PROGRAMMES',
      message: 'The guide declares channels but no programmes (channel/logo-only publication).'
    });
  }

  return analysis;
}

/**
 * @typedef {Object} IdentifierComparison
 * @property {number} matchedIdCount
 * @property {string[]} matchedIds
 * @property {number} playlistIdsWithoutEpg
 * @property {number} guideIdsNotInPlaylist
 * @property {number} guideIdsWithProgrammes
 * @property {number} matchedIdsWithProgrammes
 */

/**
 * The identifier contract, checked in one place: every id that appears in
 * both files, and every id that appears in only one of them.
 * @param {PlaylistAnalysis} playlist
 * @param {GuideAnalysis} guide
 * @returns {IdentifierComparison}
 */
export function compareIdentifiers(playlist, guide) {
  const playlistIds = new Set(playlist?.ids || []);
  const guideIds = new Set(guide?.ids || []);
  const programmeIds = new Set(guide?.programmeChannelIds || []);
  const matchedIds = [...playlistIds].filter((id) => guideIds.has(id));
  return {
    matchedIdCount: matchedIds.length,
    matchedIds,
    playlistIdsWithoutEpg: [...playlistIds].filter((id) => !guideIds.has(id)).length,
    guideIdsNotInPlaylist: [...guideIds].filter((id) => !playlistIds.has(id)).length,
    guideIdsWithProgrammes: guide?.idsWithProgrammes ?? 0,
    matchedIdsWithProgrammes: matchedIds.filter((id) => programmeIds.has(id)).length
  };
}

/**
 * Freshness verdict for a guide, independent of validity.
 * @param {GuideAnalysis} guide
 * @param {number} [now]
 * @returns {'fresh'|'ending-soon'|'expired'|'no-programmes'|'unknown'}
 */
export function guideFreshness(guide, now = Date.now()) {
  if (!guide?.validXml) return 'unknown';
  if (!guide.programmeCount) return 'no-programmes';
  if (guide.currentOrFutureProgrammes === 0) return 'expired';
  const latest = guide.latestStop ? Date.parse(guide.latestStop) : NaN;
  if (!Number.isFinite(latest)) return 'unknown';
  // Under 12 hours of schedule left: still working, but it will run out today.
  return latest - now < 12 * 60 * 60 * 1000 ? 'ending-soon' : 'fresh';
}

/**
 * Decide whether a candidate publication may replace what's live.
 * Returns structured, stage-specific errors — never a generic "something
 * went wrong".
 * @param {{
 *   playlist?: PlaylistAnalysis,
 *   guide?: GuideAnalysis,
 *   comparison?: IdentifierComparison,
 *   expectProgrammes?: boolean,
 *   previous?: {programmeCount?: number, channelCount?: number}|null,
 *   thresholds?: Partial<typeof VALIDATION_THRESHOLDS>,
 *   now?: number
 * }} input
 * @returns {{ok: boolean, status: 'valid'|'invalid', errors: {code:string,message:string}[], warnings: {code:string,message:string}[], metrics: Object}}
 */
export function assessPublication(input) {
  const thresholds = { ...VALIDATION_THRESHOLDS, ...(input.thresholds || {}) };
  const now = input.now ?? Date.now();
  const errors = [];
  const warnings = [];
  const playlist = input.playlist || null;
  const guide = input.guide || null;
  const comparison = input.comparison || (playlist && guide ? compareIdentifiers(playlist, guide) : null);

  if (playlist) {
    errors.push(...playlist.errors);
    if (playlist.bytes < thresholds.minPlaylistBytes) {
      errors.push({ code: 'PLAYLIST_TOO_SHORT', message: `The playlist is implausibly small (${playlist.bytes} bytes).` });
    }
    if (playlist.blankTvgIdCount > 0) {
      warnings.push({
        code: 'PLAYLIST_BLANK_IDS',
        message: `${playlist.blankTvgIdCount} channel(s) have no tvg-id — those channels can never show a guide.`
      });
    }
    if (playlist.duplicateIds.length > 0) {
      warnings.push({
        code: 'PLAYLIST_DUPLICATE_IDS',
        message: `${playlist.duplicateIds.length} tvg-id value(s) are used by more than one channel — players may merge them.`
      });
    }
    if (playlist.channelCount > 0 && playlist.channelsWithTvgId === 0) {
      errors.push({
        code: 'PLAYLIST_NO_IDS',
        message: 'No channel in the playlist has a tvg-id, so no channel can be joined to the guide.'
      });
    }
  }

  if (guide) {
    errors.push(...guide.errors);
    warnings.push(...guide.warnings);
    if (guide.bytes < thresholds.minGuideBytes) {
      errors.push({ code: 'GUIDE_TOO_SHORT', message: `The guide is implausibly small (${guide.bytes} bytes).` });
    }
    const freshness = guideFreshness(guide, now);
    if (freshness === 'ending-soon') {
      warnings.push({
        code: 'GUIDE_ENDING_SOON',
        message: `The guide's schedule runs out soon (last programme ends ${guide.latestStop}) — republish before then or the guide will expire.`
      });
    }
  }

  if (playlist && guide && comparison) {
    if (playlist.ids.length > 0 && guide.ids.length > 0 && comparison.matchedIdCount === 0) {
      errors.push({
        code: 'IDENTIFIERS_DISCONNECTED',
        message: 'No M3U tvg-id matches any XMLTV <channel id> — players will show the playlist with a completely empty guide.'
      });
    } else if (comparison.matchedIdCount > 0 && comparison.matchedIdsWithProgrammes === 0 && guide.programmeCount > 0) {
      errors.push({
        code: 'IDENTIFIERS_WITHOUT_PROGRAMMES',
        message: `The ${comparison.matchedIdCount} matched channel id(s) have no programmes of their own in the guide.`
      });
    }
    if (comparison.playlistIdsWithoutEpg > 0) {
      warnings.push({
        code: 'PLAYLIST_IDS_WITHOUT_EPG',
        message: `${comparison.playlistIdsWithoutEpg} playlist channel(s) have no matching XMLTV channel.`
      });
    }
    if (comparison.guideIdsNotInPlaylist > 0) {
      warnings.push({
        code: 'GUIDE_IDS_UNUSED',
        message: `${comparison.guideIdsNotInPlaylist} XMLTV channel(s) aren't referenced by the playlist.`
      });
    }
    if (input.expectProgrammes && guide.programmeCount === 0) {
      errors.push({
        code: 'EXPECTED_PROGRAMMES_MISSING',
        message: 'Programme data was expected for this publication (guide-backed channels were matched), but the guide contains no programmes at all.'
      });
    }
    // `previous` is a manifest's safe metrics block (`epgPrograms`), but a
    // bare `programmeCount` is accepted too so callers can pass either shape.
    const previousProgrammes = input.previous?.epgPrograms ?? input.previous?.programmeCount ?? 0;
    if (previousProgrammes > 0) {
      if (guide.programmeCount === 0) {
        // The live guide had real programmes and this candidate has none at
        // all — almost always "every guide source failed this run", and
        // replacing a working guide with a channel-only one is a silent
        // downgrade for the viewer. Refuse it; publish the playlist alone if
        // that's genuinely what's wanted.
        errors.push({
          code: 'PROGRAMMES_LOST',
          message: `The currently published guide contains ${previousProgrammes} programme(s) but this one contains none — refusing to replace a working guide with an empty one.`
        });
      } else if (guide.programmeCount / previousProgrammes < thresholds.minProgrammeRetentionRatio) {
        warnings.push({
          code: 'PROGRAMMES_DROPPED_SHARPLY',
          message: `Programme count fell from ${previousProgrammes} to ${guide.programmeCount} — the guide sources may be partially failing.`
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'valid' : 'invalid',
    errors,
    warnings,
    metrics: buildMetrics(playlist, guide, comparison, now)
  };
}

/**
 * Safe publication metrics — deliberately contains no stream URLs, provider
 * credentials, playlist contents or source URLs, so it can be logged,
 * returned to the browser and stored in a manifest.
 * @param {PlaylistAnalysis|null} playlist
 * @param {GuideAnalysis|null} guide
 * @param {IdentifierComparison|null} comparison
 * @param {number} [now]
 */
export function buildMetrics(playlist, guide, comparison, now = Date.now()) {
  return {
    playlistChannels: playlist?.channelCount ?? null,
    playlistChannelsWithTvgId: playlist?.channelsWithTvgId ?? null,
    playlistDuplicateIds: playlist?.duplicateIds?.length ?? null,
    epgChannels: guide?.channelCount ?? null,
    epgPrograms: guide?.programmeCount ?? null,
    epgCurrentOrFuturePrograms: guide?.currentOrFutureProgrammes ?? null,
    earliestProgramStart: guide?.earliestStart ?? null,
    latestProgramStop: guide?.latestStop ?? null,
    guideFreshness: guide ? guideFreshness(guide, now) : null,
    identifierMatchCount: comparison?.matchedIdCount ?? null,
    playlistIdsWithoutEpg: comparison?.playlistIdsWithoutEpg ?? null,
    programmeReferencesWithoutChannel: guide?.danglingProgrammeReferences ?? null
  };
}

/**
 * Cheap tripwire for the hot serving path. Full analysis belongs at publish
 * time (it parses the whole document); a Worker serving a 5MB guide on every
 * request cannot afford that, so the routes use these plus the publication
 * manifest's stored metadata instead.
 * @param {string} content
 */
export function looksLikeGuideContent(content) {
  if (typeof content !== 'string') return false;
  const head = content.slice(0, 400);
  return /<tv[\s>]/.test(head) || /<tv[\s>]/.test(content.slice(-400));
}

/**
 * @param {string} content
 */
export function looksLikePlaylistContent(content) {
  if (typeof content !== 'string') return false;
  return content.trimStart().startsWith('#EXTM3U') && content.includes('#EXTINF');
}

/**
 * Freshness derived from a publication manifest alone — no document parsing,
 * so it is safe on every request. `latestProgramStop` is the maximum stop time
 * in the published guide, which makes "everything has ended" a single
 * comparison.
 * @param {{latestProgramStop?: string|null, epgPrograms?: number|null}|null} manifest
 * @param {number} [now]
 * @returns {'fresh'|'ending-soon'|'expired'|'no-programmes'|'unknown'}
 */
export function manifestFreshness(manifest, now = Date.now()) {
  if (!manifest) return 'unknown';
  if (!manifest.epgPrograms) return 'no-programmes';
  const latest = manifest.latestProgramStop ? Date.parse(manifest.latestProgramStop) : NaN;
  if (!Number.isFinite(latest)) return 'unknown';
  if (latest < now) return 'expired';
  return latest - now < 12 * 60 * 60 * 1000 ? 'ending-soon' : 'fresh';
}

/**
 * Map an assessment onto the health status vocabulary used by the health
 * endpoint: healthy | degraded | stale | invalid | missing.
 * @param {{valid: boolean, freshness: string, warnings: number, matched: number, channels: number}} state
 * @returns {'healthy'|'degraded'|'stale'|'invalid'|'missing'}
 */
export function healthStatus(state) {
  if (!state.valid) return 'invalid';
  if (state.freshness === 'expired') return 'stale';
  if (state.freshness === 'ending-soon' || state.freshness === 'no-programmes') return 'degraded';
  if (state.warnings > 0) return 'degraded';
  if (state.channels > 0 && state.matched === 0) return 'degraded';
  return 'healthy';
}

/**
 * Byte length of a string in UTF-8 (not JS code units) — the number a
 * Content-Length header would carry.
 * @param {string} text
 */
export function byteLength(text) {
  const value = String(text || '');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  return Buffer.byteLength(value, 'utf8');
}

/**
 * SHA-256 hex digest, used for content hashes/ETags and version ids.
 * `crypto.subtle` exists in Node 18+ and in the Workers runtime, so this
 * stays platform-agnostic.
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cheap synchronous hash for weak ETags on already-stored content where no
 * stored hash is available. Not cryptographic — only used to detect change.
 * @param {string} text
 * @returns {string}
 */
export function quickHash(text) {
  let hash = 0x811c9dc5;
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Cheap, change-detecting tag for already-stored content, where no stored hash
 * exists (content published before manifests did). Hashes the length plus the
 * first/last 2KB instead of the whole document: this runs on the hot serving
 * path, and a Worker serving a multi-megabyte guide can't afford to hash it on
 * every request. Any republish changes the length or one of those windows.
 * @param {string} content
 * @returns {string}
 */
export function weakContentTag(content) {
  const text = String(content || '');
  return quickHash(`${text.length}|${text.slice(0, 2048)}|${text.slice(-2048)}`);
}

/**
 * Host-only label for a source URL — safe to log and to show in the UI.
 * Query strings and credentials (which IPTV provider URLs routinely carry)
 * are dropped, as is the full path for token-bearing URL shapes.
 * @param {string} url
 * @returns {string}
 */
export function safeSourceLabel(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.host;
  } catch {
    return 'unknown-source';
  }
}

/**
 * A short, non-reversible slug fingerprint. Logs and health responses should
 * identify a slug without making it easier to guess the public URL.
 * @param {string} slug
 * @returns {string}
 */
export function slugHash(slug) {
  return quickHash(String(slug || ''));
}
