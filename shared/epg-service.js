// Orchestration layer: combines shared/core.js (pure logic) with a
// pluggable async cache adapter and fetch-utils to implement every route's
// actual logic as a plain function returning a plain result object.
// server.js (Node/Express) and worker.js (Cloudflare Worker) both call
// these — only the cache adapter and the thin request/response glue
// differ.
//
// Cache adapter shape (all async):
//   get(name, maxAgeMs) -> parsed value or null if missing/stale
//   getStale(name)      -> parsed value or null if missing (ignores age)
//   set(name, data)     -> persists { updatedAt, data }

import {
  arrify,
  slugify,
  formatXmltvDate,
  parseM3U,
  serializeM3U,
  parseXmlTv,
  buildXmlTv,
  emptyXmlTvStub,
  pickBestName,
  pickBestLink,
  normalizeWorkerUrl,
  scoreMatch,
  extractCountryHint,
  detectTwentyFourSeven,
  cleanTitleForLookup,
  twentyFourSevenTitle,
  buildLogoMap,
  searchIptvApi,
  matchAliasRegistry,
  parseCustomGuideUrls
} from './core.js';
import { fetchWithTimeout, fetchTextMaybeGzip, fetchGuideSubset, runWithConcurrency } from './fetch-utils.js';
import {
  analyzePlaylist,
  analyzeGuide,
  compareIdentifiers,
  assessPublication,
  guideFreshness,
  manifestFreshness,
  healthStatus,
  sha256Hex,
  quickHash,
  slugHash
} from './validate.js';
import { logEvent } from './log.js';

const WORKERS_TXT_URL = 'https://raw.githubusercontent.com/iptv-org/epg/master/workers.txt';
const IPTV_API_MAX_AGE = 6 * 60 * 60 * 1000;
const WORKERS_MAX_AGE = 2 * 60 * 60 * 1000;
const SOURCE_CHANNELS_MAX_AGE = 6 * 60 * 60 * 1000;

// A single search-channel call fans out to many worker hosts; both to be a
// good citizen and to stay under serverless subrequest caps (e.g.
// Cloudflare Workers' free-plan limit), cap how many sources one request
// scans regardless of what the client asks for.
export const MAX_SOURCES_PER_REQUEST = 40;

export async function refreshIptvApi(cache, force = false) {
  if (!force) {
    const cached = await cache.get('iptv-api', IPTV_API_MAX_AGE);
    if (cached) return cached;
  }

  try {
    const [channelsRes, guidesRes, logosRes] = await Promise.all([
      fetchWithTimeout('https://iptv-org.github.io/api/channels.json', {}, 15000),
      fetchWithTimeout('https://iptv-org.github.io/api/guides.json', {}, 15000),
      fetchWithTimeout('https://iptv-org.github.io/api/logos.json', {}, 15000)
    ]);

    if (!channelsRes.ok || !guidesRes.ok || !logosRes.ok) {
      throw new Error('Unable to load IPTV-org API metadata.');
    }

    const rawChannels = await channelsRes.json();
    const rawGuides = await guidesRes.json();
    const logos = await logosRes.json();

    // guides.json is ~180k rows (≈25MB), but the vast majority have
    // channel:null (not mapped to a canonical iptv-org channel id) and
    // carry fields we never read. Prune before caching — both because a
    // stray extra MB would blow past Cloudflare KV's 25MB per-value cap,
    // and because there's no reason to keep ~90% dead weight in memory
    // either way.
    const guides = (Array.isArray(rawGuides) ? rawGuides : [])
      .filter((g) => g.channel)
      .map((g) => ({ channel: g.channel, site: g.site, site_id: g.site_id, lang: g.lang }));

    const channels = (Array.isArray(rawChannels) ? rawChannels : []).map((c) => ({
      id: c.id,
      name: c.name,
      alt_names: c.alt_names,
      country: c.country,
      categories: c.categories
    }));

    const data = {
      channels,
      guides,
      logoMap: buildLogoMap(Array.isArray(logos) ? logos : [])
    };

    await cache.set('iptv-api', data);
    return data;
  } catch (error) {
    const stale = await cache.getStale('iptv-api');
    if (stale) return stale;
    throw error;
  }
}

export async function refreshWorkers(cache, force = false) {
  if (!force) {
    const cached = await cache.get('workers', WORKERS_MAX_AGE);
    if (cached && Array.isArray(cached.sources) && cached.sources.length) return cached.sources;
  }

  try {
    const response = await fetchWithTimeout(WORKERS_TXT_URL, {}, 10000);
    if (!response.ok) {
      throw new Error(`Could not fetch worker list (HTTP ${response.status}).`);
    }

    const text = await response.text();
    const hosts = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .slice(0, 300);

    const sources = await runWithConcurrency(hosts, 16, async (host) => {
      const base = host.startsWith('http') ? host : `https://${host}`;
      const workerJsonUrl = `${base.replace(/\/$/, '')}/worker.json`;

      try {
        const res = await fetchWithTimeout(workerJsonUrl, { redirect: 'follow' }, 6000);
        if (!res.ok) return null;
        const json = await res.json();

        const channelsUrl = normalizeWorkerUrl(workerJsonUrl, json.channels);
        const guideUrl = normalizeWorkerUrl(workerJsonUrl, json.guide);
        if (!channelsUrl || !guideUrl) return null;

        return { id: host, name: host, host, channelsUrl, guideUrl };
      } catch {
        return null;
      }
    });

    await cache.set('workers', { sources });
    return sources;
  } catch (error) {
    const stale = await cache.getStale('workers');
    if (stale && Array.isArray(stale.sources) && stale.sources.length) return stale.sources;
    throw error;
  }
}

// v2: cached channel entries now carry hasSchedule — bump the key so
// pre-fix cache entries (which lack that field, reading as falsy) don't
// masquerade as "no schedule" for up to SOURCE_CHANNELS_MAX_AGE after
// this shipped, instead of just failing open as no-cache-hit once.
export async function loadSourceChannels(cache, source) {
  const cached = await cache.get(`source:v2:${source.id}`, SOURCE_CHANNELS_MAX_AGE);
  if (cached && Array.isArray(cached.channels)) return cached.channels;

  const xml = await fetchTextMaybeGzip(source.channelsUrl);
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
  const parsed = parser.parse(xml);

  let channels = [];
  if (parsed.channels && parsed.channels.channel) {
    // Classic WebGrab+Plus-style channel catalog — a plain id/name
    // mapping, never carries programmes of its own.
    channels = arrify(parsed.channels.channel).map((c) => {
      const display = typeof c === 'string' ? c : (c['#text'] || c['@_name'] || '');
      return {
        id: c['@_xmltv_id'] || c['@_id'] || '',
        name: display || c['@_site_name'] || c['@_site_id'] || '',
        logoUrl: null,
        hasSchedule: false
      };
    });
  } else if (parsed.tv && parsed.tv.channel) {
    // A channel node existing here doesn't mean it has a real schedule —
    // an EPG generator that can't identify a channel will often still
    // emit a placeholder <channel> (mirroring the input name back, maybe
    // with a logo) with zero matching <programme> entries. Track which
    // channel ids actually have at least one programme so a placeholder
    // isn't scored as confidently as a real match — this is exactly what
    // let an unidentified 24/7 movie channel's own empty stub outscore a
    // correct TMDB identification (score high enough to count as a
    // "confident guide match" and suppress the TMDB fallback entirely,
    // while adding zero real programmes on export).
    const scheduledIds = new Set(
      arrify(parsed.tv.programme).map((p) => p['@_channel']).filter(Boolean)
    );

    channels = arrify(parsed.tv.channel).map((c) => {
      const names = arrify(c['display-name']).map((n) => {
        if (typeof n === 'string') return n;
        if (n && typeof n['#text'] === 'string') return n['#text'];
        return '';
      }).filter(Boolean);
      const icon = Array.isArray(c.icon) ? c.icon[0] : c.icon;
      const id = c['@_id'] || '';
      return {
        id,
        name: names[0] || id,
        logoUrl: (icon && icon['@_src']) || null,
        hasSchedule: scheduledIds.has(id)
      };
    });
  }

  await cache.set(`source:v2:${source.id}`, { channels });
  return channels;
}

export async function tmdbSearch(cache, apiKey, title) {
  if (!apiKey || !title) return [];
  const key = `tmdb:${title.toLowerCase()}`;
  const cached = await cache.get(key, 30 * 24 * 60 * 60 * 1000);
  if (cached) return cached.results;

  try {
    const url = `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(title)}&include_adult=false`;
    const res = await fetchWithTimeout(url, {}, 8000);
    if (!res.ok) return [];

    const json = await res.json();
    const results = (json.results || [])
      .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
      .slice(0, 3)
      .map((r) => ({
        title: r.title || r.name || title,
        overview: r.overview || '',
        year: (r.release_date || r.first_air_date || '').slice(0, 4) || null,
        mediaType: r.media_type,
        posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null
      }));

    await cache.set(key, { results });
    return results;
  } catch {
    return [];
  }
}

export async function discoverSources(cache, force) {
  const sources = await refreshWorkers(cache, force);
  return { count: sources.length, sources };
}

export async function parseFiles({ m3uContent, xmlContent }) {
  if (!m3uContent) {
    throw new Error('m3uContent is required.');
  }

  const m3uChannels = parseM3U(m3uContent);
  const effectiveXmlContent = xmlContent && xmlContent.trim() ? xmlContent : emptyXmlTvStub();
  const xml = parseXmlTv(effectiveXmlContent);

  return {
    m3uChannels,
    xmlContent: effectiveXmlContent,
    xmlSummary: {
      channelCount: xml.channels.length,
      programmeCount: xml.programmes.length,
      channels: xml.channels.map((c) => ({ id: c.id, names: c.names }))
    }
  };
}

export async function searchChannel(cache, apiKey, { channelName, tvgId, groupTitle, maxSources, customGuideUrl }) {
  if (!channelName || !channelName.trim()) {
    throw new Error('channelName is required.');
  }

  const normalizedTvgId = (tvgId || '').trim().toLowerCase();
  const isTwentyFourSeven = detectTwentyFourSeven(channelName, groupTitle);
  const cleanedTitle = cleanTitleForLookup(channelName);
  const countryHint = extractCountryHint(`${channelName} ${groupTitle || ''}`);

  const sources = await refreshWorkers(cache, false);
  const requestedCount = Math.max(1, Math.min(Number(maxSources) || MAX_SOURCES_PER_REQUEST, MAX_SOURCES_PER_REQUEST, sources.length));

  // Scanning every source is expensive, so when we can only afford a
  // subset, prioritize the ones whose host name actually looks related to
  // this channel (country / name tokens) instead of an arbitrary
  // (effectively alphabetical) slice.
  const relevanceTokens = `${channelName} ${cleanedTitle}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  const rankedSources = [...sources].sort((a, b) => {
    const scoreSource = (source) => {
      const host = (source.host || '').toLowerCase();
      let s = 0;
      if (countryHint && host.includes(countryHint.toLowerCase())) s += 3;
      for (const token of relevanceTokens) {
        if (host.includes(token)) s += 1;
      }
      return s;
    };
    return scoreSource(b) - scoreSource(a);
  });
  const sourceSlice = rankedSources.slice(0, requestedCount);

  // User-supplied EPGs (their own provider's guide, a region-specific
  // community guide, ...) are known-good, exact-fit sources — always
  // scan all of them, on top of the scan-limited public sources, not
  // instead of one of them. One per line (or comma-separated) so more
  // than one can be combined — e.g. a general-lineup guide plus a
  // region-specific one that covers channels the first doesn't.
  const customGuideUrls = parseCustomGuideUrls(customGuideUrl);
  for (const url of customGuideUrls.slice().reverse()) {
    sourceSlice.unshift({ id: `custom:${url}`, name: 'Your EPG', host: 'custom', channelsUrl: url, guideUrl: url });
  }

  const sourceMatchesNested = await runWithConcurrency(sourceSlice, 10, async (source) => {
    try {
      const sourceChannels = await loadSourceChannels(cache, source);
      const matches = [];
      for (const sc of sourceChannels) {
        if (isTwentyFourSeven && !cleanTitleForLookup(sc.name)) continue;

        let score = isTwentyFourSeven
          ? scoreMatch(cleanedTitle, sc.name)
          : Math.max(
              scoreMatch(channelName, sc.name),
              scoreMatch(channelName, sc.id),
              scoreMatch(cleanedTitle, sc.name)
            );
        if (normalizedTvgId && sc.id && sc.id.toLowerCase() === normalizedTvgId) {
          score = 1;
        }
        if (score < (isTwentyFourSeven ? 0.6 : 0.48)) continue;

        matches.push({
          sourceType: 'worker',
          source: source.name,
          score,
          channelName: sc.name,
          channelId: sc.id,
          // Only offer a guide merge when this specific channel actually
          // has programme data in this source — a channel node existing
          // isn't a promise of that (see loadSourceChannels).
          guideUrl: sc.hasSchedule ? source.guideUrl : null,
          channelsUrl: source.channelsUrl,
          logoUrl: sc.logoUrl || null,
          canMergeGuide: !!sc.hasSchedule
        });
      }
      return matches.slice(0, 5);
    } catch {
      return [];
    }
  });

  const workerMatches = sourceMatchesNested.flat();

  const iptv = await refreshIptvApi(cache, false);
  const apiMatches = searchIptvApi(channelName, cleanedTitle, isTwentyFourSeven, iptv.channels, iptv.guides, iptv.logoMap || {}, countryHint);
  // Identifies channels the alias registry knows about but iptv-org's own
  // catalog doesn't carry at all (e.g. ESPN.nz — confirmed absent
  // upstream) — apiMatches alone could never surface these since there's
  // no catalog channel for an alt_name to attach to in the first place.
  const registryMatches = matchAliasRegistry(channelName, cleanedTitle, isTwentyFourSeven, countryHint);

  const all = [...workerMatches, ...apiMatches, ...registryMatches]
    .sort((a, b) => b.score - a.score)
    .slice(0, 35);

  // iptv-org-api matches are metadata/logo only (canMergeGuide is always
  // false for them) — they never provide a real schedule, so only a
  // confident worker (guide-backed) match should suppress the TMDB
  // fallback for a detected 24/7 channel.
  const hasConfidentGuideMatch = all.some((m) => m.canMergeGuide && m.score >= 0.6);

  let tmdbMatches = [];
  if (isTwentyFourSeven && !hasConfidentGuideMatch && apiKey) {
    const candidates = await tmdbSearch(cache, apiKey, cleanedTitle);
    tmdbMatches = candidates.map((c, i) => ({
      sourceType: 'tmdb',
      source: 'TMDB',
      // Above the general 0.6 confidence bar (so a real TMDB
      // identification outranks a coincidental iptv-org-api match in
      // auto-match) but below a near-exact catalog hit.
      score: 0.72 - i * 0.05,
      channelName: c.title,
      channelId: null,
      logoUrl: c.posterUrl,
      canMergeGuide: false,
      canSynthesizeGuide: true,
      tmdb: c
    }));
  }

  return {
    query: channelName,
    searchedSources: sourceSlice.length,
    context: {
      isTwentyFourSeven,
      cleanedTitle,
      countryHint,
      tmdbConfigured: !!apiKey
    },
    matches: [...all, ...tmdbMatches]
  };
}

export async function mergeGuide({ baseXml, guideUrl, channelId, preferredName, logoUrl }) {
  if (!baseXml || !guideUrl || !channelId) {
    throw new Error('baseXml, guideUrl and channelId are required.');
  }

  const base = parseXmlTv(baseXml);
  const guideXml = await fetchTextMaybeGzip(guideUrl);
  const guide = parseXmlTv(guideXml);

  // Exact-id only (see resolveGuideChannel): the id written into the M3U for
  // this channel is `channelId`, so the XMLTV channel node added here must use
  // the same id or the two files are disconnected for that channel.
  const matchedChannel = resolveGuideChannel(guide, channelId, preferredName);

  if (!matchedChannel) {
    const err = new Error(`Channel "${channelId}" was not found in the selected guide, so no guide channel was added (the playlist's tvg-id for this channel is unchanged).`);
    err.status = 404;
    err.code = 'GUIDE_CHANNEL_NOT_FOUND';
    throw err;
  }

  base.tv.channel = arrify(base.tv.channel);
  base.tv.programme = arrify(base.tv.programme);

  const existingChannelIdx = base.tv.channel.findIndex((c) => c['@_id'] === matchedChannel.id);
  let channelNode;
  if (existingChannelIdx === -1) {
    channelNode = matchedChannel.raw;
    if (!channelNode['display-name']) {
      channelNode['display-name'] = [preferredName || matchedChannel.id];
    }
    base.tv.channel.push(channelNode);
  } else {
    channelNode = base.tv.channel[existingChannelIdx];
  }

  if (logoUrl) {
    channelNode.icon = { '@_src': logoUrl };
  }

  const guideProgrammes = guide.programmes.filter((p) => p['@_channel'] === matchedChannel.id);
  const existingProgrammeKeys = new Set(
    base.tv.programme.map((p) => `${p['@_channel']}|${p['@_start']}|${p['@_stop']}|${JSON.stringify(p.title || '')}`)
  );

  let addedProgrammes = 0;
  for (const programme of guideProgrammes) {
    const key = `${programme['@_channel']}|${programme['@_start']}|${programme['@_stop']}|${JSON.stringify(programme.title || '')}`;
    if (!existingProgrammeKeys.has(key)) {
      base.tv.programme.push(programme);
      existingProgrammeKeys.add(key);
      addedProgrammes += 1;
    }
  }

  return {
    mergedXml: buildXmlTv(base.tv),
    addedProgrammes,
    addedChannelId: matchedChannel.id,
    addedChannelName: pickBestName(matchedChannel.names, matchedChannel.id)
  };
}

export async function applyIdentity({ baseXml, channelId, channelName, logoUrl, synthesize, title, overview, days }) {
  if (!baseXml || !channelId) {
    throw new Error('baseXml and channelId are required.');
  }

  const base = parseXmlTv(baseXml);
  base.tv.channel = arrify(base.tv.channel);
  base.tv.programme = arrify(base.tv.programme);

  let channelNode = base.tv.channel.find((c) => c['@_id'] === channelId);
  if (!channelNode) {
    channelNode = { '@_id': channelId, 'display-name': [channelName || channelId] };
    base.tv.channel.push(channelNode);
  }

  if (logoUrl) {
    channelNode.icon = { '@_src': logoUrl };
  }

  let addedProgrammes = 0;
  if (synthesize) {
    base.tv.programme = base.tv.programme.filter((p) => p['@_channel'] !== channelId);

    const dayCount = Math.max(1, Math.min(Number(days) || 3, 14));
    const startDate = new Date();
    startDate.setUTCHours(0, 0, 0, 0);

    for (let i = 0; i < dayCount; i += 1) {
      const start = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      const stop = new Date(start.getTime() + 24 * 60 * 60 * 1000);

      const programme = {
        '@_channel': channelId,
        '@_start': formatXmltvDate(start),
        '@_stop': formatXmltvDate(stop),
        title: [{ '#text': title || channelName || channelId, '@_lang': 'en' }],
        category: [{ '#text': '24/7', '@_lang': 'en' }]
      };
      if (overview) {
        programme.desc = [{ '#text': overview, '@_lang': 'en' }];
      }

      base.tv.programme.push(programme);
      addedProgrammes += 1;
    }
  }

  return {
    mergedXml: buildXmlTv(base.tv),
    addedChannelId: channelId,
    addedProgrammes
  };
}

export async function exportM3u({ channels, links }) {
  if (!Array.isArray(channels)) {
    throw new Error('channels must be an array.');
  }

  const linkMap = new Map();
  for (const link of arrify(links)) {
    if (link && Number.isInteger(link.channelIndex)) {
      linkMap.set(link.channelIndex, link);
    }
  }

  const updated = channels.map((channel) => {
    const link = linkMap.get(channel.index);
    const attrs = { ...(channel.attrs || {}) };

    if (link && link.channelId) attrs['tvg-id'] = link.channelId;
    if (link && link.channelName) attrs['tvg-name'] = link.channelName;
    if (link && link.logoUrl) attrs['tvg-logo'] = link.logoUrl;

    return { ...channel, attrs };
  });

  return { m3u: serializeM3U(updated) };
}

// ---- publishing (hosted M3U/XML for IPTV player apps) --------------------
//
// Lets a finished playlist/guide be saved to a stable URL — /iptv/<slug>.m3u
// and /epg/<slug>.xml — that a player app (TiViMate, etc.) can point at
// directly instead of re-exporting and re-uploading by hand every time.
// Uses the same cache-adapter interface as the EPG cache, just pointed at a
// separate store/namespace so published content isn't subject to the EPG
// cache's freshness/eviction behavior.

const MAX_PUBLISHED_CONTENT_LENGTH = 15 * 1024 * 1024; // 15MB per file

// Storage keys. Two generations coexist deliberately:
//
//   hosted:<slug>:versions:<version>:playlist|epg   validated candidate pair
//   hosted:<slug>:manifest                         the single switch to promote
//   hosted:<slug>:m3u / :xml                       legacy/serving keys
//
// The version keys are written first and only promoted via the manifest, so
// readers that follow the manifest always see a validated *pair* — a crash or
// a failed second write can't leave the M3U from one publication next to the
// guide from another. The legacy keys are still written (and still the
// fallback for anything published before this existed), which is what keeps
// already-published slugs working.
function manifestKey(slug) {
  return `hosted:${slug}:manifest`;
}

function versionKey(slug, version, kind) {
  return `hosted:${slug}:versions:${version}:${kind}`;
}

// 'm3u'/'xml' are the kind names the serving routes used historically; both
// spellings must keep working so an already-published slug (and any external
// caller) isn't broken by the rename to 'playlist'/'epg'.
function normalizeKind(kind) {
  if (kind === 'm3u' || kind === 'playlist') return 'playlist';
  if (kind === 'xml' || kind === 'epg') return 'epg';
  throw publishError(`Unknown hosted file kind: ${kind}`, 'HOSTED_KIND_INVALID', 400);
}

function legacyKey(slug, kind) {
  return `hosted:${slug}:${normalizeKind(kind) === 'playlist' ? 'm3u' : 'xml'}`;
}

function publishError(message, code, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/**
 * Validate a candidate M3U/XMLTV pair and, only if it passes, publish it.
 *
 * Refuses to replace what's already live with output that would leave a
 * player with a broken or empty guide (the exact production failure this
 * exists to prevent), and verifies every write by reading it back.
 *
 * @param {Object} store hosted store adapter
 * @param {string} slugInput
 * @param {{m3uContent?: string, xmlContent?: string, overrides?: Object, expectProgrammes?: boolean, now?: number}} input
 * @returns {Promise<{slug: string, version: string, manifest: Object, warnings: Object[], metrics: Object}>}
 */
export async function publishFiles(store, slugInput, { m3uContent, xmlContent, overrides, plan, expectProgrammes = false, now = Date.now() } = {}) {
  const slug = slugify(slugInput);
  if (!slug) {
    throw publishError('A valid slug is required (letters, numbers, dashes).', 'SLUG_INVALID', 400);
  }
  if (!m3uContent && !xmlContent) {
    throw publishError('Nothing to publish — provide m3uContent and/or xmlContent.', 'NOTHING_TO_PUBLISH', 400);
  }
  if ((m3uContent && m3uContent.length > MAX_PUBLISHED_CONTENT_LENGTH) ||
      (xmlContent && xmlContent.length > MAX_PUBLISHED_CONTENT_LENGTH)) {
    throw publishError('File too large to publish (15MB limit per file).', 'CONTENT_TOO_LARGE', 413);
  }

  const stage = { slugHash: slugHash(slug) };
  logEvent('publish.started', { ...stage, hasPlaylist: !!m3uContent, hasGuide: !!xmlContent });

  const previousManifest = await store.getStale(manifestKey(slug));
  const playlistAnalysis = m3uContent ? analyzePlaylist(m3uContent) : null;
  const guideAnalysis = xmlContent ? analyzeGuide(xmlContent, { now }) : null;
  const comparison = playlistAnalysis && guideAnalysis ? compareIdentifiers(playlistAnalysis, guideAnalysis) : null;

  const assessment = assessPublication({
    playlist: playlistAnalysis,
    guide: guideAnalysis,
    comparison,
    expectProgrammes,
    previous: previousManifest?.metrics || null,
    now
  });

  logEvent('publish.validation.completed', {
    ...stage,
    ok: assessment.ok,
    programCount: assessment.metrics.epgPrograms,
    channelCount: assessment.metrics.playlistChannels
  }, assessment.ok ? 'info' : 'warn');

  if (!assessment.ok) {
    const error = publishError(
      `Publication blocked — the generated files would leave a player without a working guide: ${assessment.errors.map((e) => e.message).join(' ')}`,
      'PUBLISH_VALIDATION_FAILED',
      422
    );
    error.details = { errors: assessment.errors, warnings: assessment.warnings, metrics: assessment.metrics };
    logEvent('publish.validation.failed', { ...stage, errors: assessment.errors.map((e) => e.code) }, 'error');
    throw error;
  }

  const version = `v${now.toString(36)}-${(await sha256Hex(`${m3uContent || ''}\u0000${xmlContent || ''}`)).slice(0, 12)}`;

  // 1. Write the candidate pair under version-scoped keys.
  const candidates = [];
  if (m3uContent) candidates.push({ kind: 'playlist', content: m3uContent });
  if (xmlContent) candidates.push({ kind: 'epg', content: xmlContent });

  for (const candidate of candidates) {
    try {
      await store.set(versionKey(slug, version, candidate.kind), candidate.content, { strict: true, ttlSeconds: null });
    } catch (error) {
      logEvent('publish.storage.write.failed', { ...stage, version, part: candidate.kind, errorCode: error.code, error: error.message }, 'error');
      throw publishError(`Could not store the ${candidate.kind === 'playlist' ? 'playlist' : 'guide'} (storage write failed). Nothing was published; the previous version is still live.`, 'PUBLISH_STORAGE_WRITE_FAILED', 503);
    }
  }

  // 2. Read every candidate back and confirm it is byte-identical. A write
  //    that silently stored something else (truncation, a size cap, a wrong
  //    type) is exactly the failure mode that produces "200 OK but no EPG".
  for (const candidate of candidates) {
    const readback = await store.getStale(versionKey(slug, version, candidate.kind));
    if (readback !== candidate.content) {
      logEvent('publish.storage.readback.failed', { ...stage, version, part: candidate.kind }, 'error');
      throw publishError('The published files could not be verified after writing (read-back did not match). Nothing was published; the previous version is still live.', 'PUBLISH_READBACK_FAILED', 500);
    }
  }

  const contentHashes = {
    playlist: m3uContent ? await sha256Hex(m3uContent) : null,
    epg: xmlContent ? await sha256Hex(xmlContent) : null
  };

  // 3. Promote. The manifest is a single key, so promoting a validated pair
  //    is one write — Cloudflare KV has no cross-key transaction, so this is
  //    the closest thing to an atomic switch available, and it is why readers
  //    resolve content *through* the manifest.
  const publicationWarnings = [...assessment.warnings];
  const manifest = {
    schemaVersion: 2,
    activeVersion: version,
    previousVersion: previousManifest?.activeVersion || null,
    publishedAt: new Date(now).toISOString(),
    playlistBytes: playlistAnalysis ? playlistAnalysis.bytes : null,
    epgBytes: guideAnalysis ? guideAnalysis.bytes : null,
    playlistChannels: assessment.metrics.playlistChannels,
    epgChannels: assessment.metrics.epgChannels,
    epgPrograms: assessment.metrics.epgPrograms,
    epgCurrentOrFuturePrograms: assessment.metrics.epgCurrentOrFuturePrograms,
    earliestProgramStart: assessment.metrics.earliestProgramStart,
    latestProgramStop: assessment.metrics.latestProgramStop,
    guideFreshness: assessment.metrics.guideFreshness,
    identifierMatchCount: assessment.metrics.identifierMatchCount,
    identifierMatchRatio: playlistAnalysis?.channelsWithTvgId
      ? Math.round((assessment.metrics.identifierMatchCount / playlistAnalysis.channelsWithTvgId) * 1000) / 1000
      : null,
    contentHashes,
    metrics: assessment.metrics,
    warnings: assessment.warnings.map((w) => w.code)
  };
  // The manifest is written before the expiry warning is computed (it is part
  // of the promoted pair), so it keeps the validation codes only — the
  // renewal warning is a property of the publication *and* the saved
  // schedule, and would go stale in storage the moment a config is added.

  await store.set(manifestKey(slug), manifest, { strict: true, ttlSeconds: null });

  // 4. Legacy/serving keys, kept in step for existing readers and for any
  //    other code path that still reads hosted:<slug>:m3u|xml directly.
  for (const candidate of candidates) {
    await store.set(legacyKey(slug, candidate.kind), candidate.content, { strict: true, ttlSeconds: null });
  }

  // Whatever's manually confirmed at publish time becomes the full set of
  // protected overrides for this slug going forward — see
  // getChannelOverrides/runAutoRefresh below for why this exists and how
  // it's used. An empty object (no manual links this session) is a valid,
  // deliberate value: it clears any previously-saved overrides rather than
  // leaving stale ones from an earlier publish in place.
  if (overrides && typeof overrides === 'object') {
    await store.set(`overrides:${slug}`, overrides, { strict: true, ttlSeconds: null });
  }

  // Every channel's current match, so a scheduled refresh can renew the
  // schedule from the same sources without re-searching (see runAutoRefresh).
  if (plan && typeof plan === 'object') {
    await store.set(planKey(slug), plan, { strict: true, ttlSeconds: null });
  }

  // Keep the active and previous versions only. Each publish writes a full
  // copy of the guide, so without this a nightly refresh grows storage by a
  // guide's worth every day.
  const retired = previousManifest?.previousVersion;
  if (retired && retired !== version && retired !== manifest.previousVersion && typeof store.remove === 'function') {
    for (const kind of ['playlist', 'epg']) {
      try {
        await store.remove(versionKey(slug, retired, kind));
      } catch (error) {
        logEvent('publish.prune.failed', { ...stage, version: retired, errorCode: error.code || null }, 'warn');
      }
    }
  }

  // The publication is valid and the guide has current programmes — but a
  // guide is a schedule, so "valid and current" only means it works *today*.
  // With nothing scheduled to renew it, this exact publication is the start of
  // the outage: it will keep returning 200 while every channel's EPG silently
  // empties. Reported as a warning on the publish response (not an error — the
  // files themselves are fine) so the UI can say so at the moment the user is
  // looking at the result, which is the only moment they can still act on it.
  if (guideAnalysis && guideAnalysis.currentOrFutureProgrammes > 0) {
    const refreshConfig = await store.getStale(refreshConfigKey(slug));
    if (!refreshConfig?.intervalKey) {
      publicationWarnings.push({
        code: 'GUIDE_WILL_EXPIRE_WITHOUT_REFRESH',
        message: 'This guide appears healthy but will eventually expire unless auto-refresh is enabled.',
        expiresAt: guideAnalysis.latestStop,
        expiresInMs: guideAnalysis.latestStop ? Date.parse(guideAnalysis.latestStop) - now : null,
        paused: !!refreshConfig
      });
    }
  }

  logEvent('publish.completed', {
    ...stage,
    version,
    channelCount: assessment.metrics.playlistChannels,
    programCount: assessment.metrics.epgPrograms,
    warnings: publicationWarnings.length
  });

  return { slug, version, manifest, warnings: publicationWarnings, metrics: assessment.metrics };
}

/**
 * Resolve published content, preferring the manifest's active version (a
 * validated pair) and falling back to the legacy keys for anything published
 * before the manifest existed.
 * @param {Object} store
 * @param {string} slugInput
 * @param {'playlist'|'epg'} kind
 * @param {{version?: string|null}} [options]
 * @returns {Promise<{content: string, version: string|null, publishedAt: string|null, source: 'version'|'legacy'} | null>}
 */
export async function resolveHostedFile(store, slugInput, kindInput, options = {}) {
  const slug = slugify(slugInput);
  if (!slug) return null;
  const kind = normalizeKind(kindInput);

  if (!options.version) {
    const manifest = await store.getStale(manifestKey(slug));
    if (manifest?.activeVersion) {
      const content = await store.getStale(versionKey(slug, manifest.activeVersion, kind));
      if (typeof content === 'string' && content) {
        return {
          content,
          version: manifest.activeVersion,
          publishedAt: manifest.publishedAt || null,
          publishedAtSource: manifest.publishedAt ? 'manifest' : null,
          manifest,
          source: 'version'
        };
      }
    }
  } else {
    const content = await store.getStale(versionKey(slug, options.version, kind));
    if (typeof content === 'string' && content) {
      return { content, version: options.version, publishedAt: null, manifest: null, source: 'version' };
    }
  }

  // Legacy keys carry no manifest, so there is no recorded publishedAt — but
  // the stored envelope does carry when it was written, which for a published
  // file is when it was published. Reporting that beats reporting "unknown"
  // for every slug that predates manifests (which, on a live deployment, is
  // all of them until they are republished once).
  const legacyEntry = typeof store.getEntry === 'function'
    ? await store.getEntry(legacyKey(slug, kind))
    : { data: await store.getStale(legacyKey(slug, kind)), updatedAt: null };
  const legacy = legacyEntry?.data;
  if (typeof legacy === 'string' && legacy) {
    return {
      content: legacy,
      version: null,
      publishedAt: legacyEntry.updatedAt ? new Date(legacyEntry.updatedAt).toISOString() : null,
      publishedAtSource: legacyEntry.updatedAt ? 'legacy-write-time' : null,
      manifest: null,
      source: 'legacy'
    };
  }
  return null;
}

/**
 * Backwards-compatible string-returning reader (used by callers that only
 * want the content). Prefer resolveHostedFile where version/health metadata
 * matters.
 * @param {Object} store
 * @param {string} slugInput
 * @param {'playlist'|'epg'} kind
 * @returns {Promise<string|null>}
 */
export async function getHostedFile(store, slugInput, kind) {
  const resolved = await resolveHostedFile(store, slugInput, kind);
  return resolved ? resolved.content : null;
}

/**
 * Read-only health report for a published slug: the identifier contract, the
 * guide's freshness, and what storage is actually serving. Diagnostic only —
 * never contains stream URLs, credentials or playlist contents.
 * @param {Object} store
 * @param {string} slugInput
 * @param {{now?: number}} [options]
 * @returns {Promise<Object>}
 */
export async function assessPublishedHealth(store, slugInput, options = {}) {
  const now = options.now ?? Date.now();
  const slug = slugify(slugInput);
  const warnings = [];

  if (!slug) {
    return { status: 'missing', slug: null, published: false, warnings: ['Not a valid slug.'], checkedAt: new Date(now).toISOString() };
  }

  let manifest = null;
  let playlist = null;
  let epg = null;
  try {
    manifest = await store.getStale(manifestKey(slug));
    playlist = await resolveHostedFile(store, slug, 'playlist');
    epg = await resolveHostedFile(store, slug, 'epg');
  } catch (error) {
    return {
      status: 'missing',
      slug,
      published: false,
      warnings: [`Storage is not readable: ${error.message}`],
      checkedAt: new Date(now).toISOString()
    };
  }

  if (!playlist && !epg) {
    return { status: 'missing', slug, published: false, warnings: ['Nothing has been published under this slug.'], checkedAt: new Date(now).toISOString() };
  }

  const playlistAnalysis = playlist ? analyzePlaylist(playlist.content) : null;
  const guideAnalysis = epg ? analyzeGuide(epg.content, { now }) : null;
  const comparison = playlistAnalysis && guideAnalysis ? compareIdentifiers(playlistAnalysis, guideAnalysis) : null;
  const freshness = guideAnalysis ? guideFreshness(guideAnalysis, now) : 'unknown';

  let valid = true;
  if (playlist && !playlistAnalysis.valid) { valid = false; warnings.push(...playlistAnalysis.errors.map((e) => e.message)); }
  if (guideAnalysis && !guideAnalysis.validXml) { valid = false; warnings.push(...guideAnalysis.errors.map((e) => e.message)); }
  if (guideAnalysis && guideAnalysis.validXml && guideAnalysis.errors.length) { warnings.push(...guideAnalysis.errors.map((e) => e.message)); }
  if (guideAnalysis?.warnings?.length) warnings.push(...guideAnalysis.warnings.map((w) => w.message));
  if (!epg) warnings.push('No guide is published for this slug — players will show a playlist with no EPG.');
  if (!playlist) warnings.push('No playlist is published for this slug.');
  if (comparison && comparison.matchedIdCount === 0 && (playlistAnalysis?.ids.length || 0) > 0) {
    valid = false;
    warnings.push('No M3U tvg-id matches any XMLTV <channel id> — players will show an empty guide for every channel.');
  }

  // Renewal is reported here too, not just in the all-slugs dashboard: "healthy"
  // about a slug that nothing will ever re-publish is the reassurance that let
  // the production guide die quietly. Same warning vocabulary as the dashboard
  // so the two views can never disagree.
  const refreshConfig = await store.getStale(refreshConfigKey(slug));
  const schedule = describeRefreshSchedule(refreshConfig, now);
  const latestStop = guideAnalysis?.latestStop || null;
  const latestStopMs = latestStop ? Date.parse(latestStop) : NaN;
  const expiresInMs = Number.isFinite(latestStopMs) ? latestStopMs - now : null;
  if (freshness === 'expired') warnings.push(freshnessWarning('GUIDE_EXPIRED').message);
  else if (freshness === 'ending-soon') warnings.push(freshnessWarning('GUIDE_ENDING_SOON').message);
  const overdue = isAutoRefreshOverdue(refreshConfig, schedule, now);
  if (schedule.paused) warnings.push(freshnessWarning('AUTO_REFRESH_PAUSED').message);
  else if (!schedule.enabled) warnings.push(freshnessWarning('NO_AUTO_REFRESH').message);
  else if (overdue) warnings.push(freshnessWarning('AUTO_REFRESH_OVERDUE').message);
  else if (schedule.lastRunStatus === 'error') warnings.push(freshnessWarning('AUTO_REFRESH_FAILING').message);

  const status = healthStatus({
    valid,
    freshness,
    warnings: warnings.length,
    matched: comparison?.matchedIdCount ?? 0,
    channels: guideAnalysis?.channelCount ?? 0
  });

  return {
    status,
    slug,
    published: true,
    refresh: schedule,
    expiry: {
      at: latestStop,
      inMs: expiresInMs,
      expired: expiresInMs != null && expiresInMs <= 0,
      expiresWithinHours: expiresInMs != null && expiresInMs > 0 ? Math.round((expiresInMs / 3600000) * 10) / 10 : null
    },
    storage: {
      activeVersion: manifest?.activeVersion || epg?.version || null,
      publishedAt: manifest?.publishedAt || epg?.publishedAt || null,
      source: epg?.source || playlist?.source || null,
      lastKnownGoodAvailable: !!(manifest?.previousVersion)
    },
    playlist: playlistAnalysis
      ? {
          valid: playlistAnalysis.valid,
          bytes: playlistAnalysis.bytes,
          channels: playlistAnalysis.channelCount,
          channelsWithTvgId: playlistAnalysis.channelsWithTvgId,
          duplicateIds: playlistAnalysis.duplicateIds.length
        }
      : null,
    epg: guideAnalysis
      ? {
          validXml: guideAnalysis.validXml,
          bytes: guideAnalysis.bytes,
          channels: guideAnalysis.channelCount,
          programmes: guideAnalysis.programmeCount,
          earliestStart: guideAnalysis.earliestStart,
          latestStop: guideAnalysis.latestStop,
          currentOrFutureProgrammes: guideAnalysis.currentOrFutureProgrammes,
          expiredProgrammes: guideAnalysis.expiredProgrammes,
          freshness,
          // Countdown data for the UI: "expires in 3.2 days" is what makes an
          // imminent expiry legible before it happens.
          expiresAt: latestStop,
          expiresInMs
        }
      : null,
    mapping: {
      matchedIds: comparison?.matchedIdCount ?? null,
      matchedIdsWithProgrammes: comparison?.matchedIdsWithProgrammes ?? null,
      playlistIdsWithoutEpg: comparison?.playlistIdsWithoutEpg ?? null,
      guideIdsNotInPlaylist: comparison?.guideIdsNotInPlaylist ?? null,
      programmeReferencesWithoutChannel: guideAnalysis?.danglingProgrammeReferences ?? null
    },
    warnings,
    checkedAt: new Date(now).toISOString()
  };
}

/**
 * Stable validator for a stored document, used to decide whether the live
 * publication is worth serving or whether the previous version should be
 * preferred. Exported so the serving routes and the diagnose script share one
 * definition of "good enough to serve".
 * @param {'playlist'|'epg'} kind
 * @param {string} content
 * @param {number} [now]
 */
export function isServableContent(kindInput, content, now = Date.now()) {
  if (typeof content !== 'string' || !content.trim()) return false;
  if (normalizeKind(kindInput) === 'playlist') return analyzePlaylist(content).valid;
  const analysis = analyzeGuide(content, { now });
  return analysis.validXml && analysis.channelCount > 0;
}

/**
 * Resolve the guide's channel entry for a specific channel id — the join that
 * decides whether the XMLTV id and the M3U tvg-id still agree.
 *
 * Only ever returns a channel whose id is *exactly* the requested one. A
 * name-based fallback that silently resolves to a different id is how the two
 * files drift apart: the playlist keeps tvg-id=A while the guide gains a
 * <channel id="B">, and the player shows that channel with no EPG. Guides
 * that carry programmes but no <channel> node for an id are still handled —
 * the node is synthesised *for that same id*, which keeps the contract.
 *
 * @param {{channels: Array, programmes: Array}} guide
 * @param {string} channelId
 * @param {string} [preferredName]
 * @returns {{id: string, names: string[], raw: Object}|null}
 */
export function resolveGuideChannel(guide, channelId, preferredName) {
  const wanted = String(channelId || '');
  if (!wanted) return null;
  const direct = arrify(guide.channels).find((c) => c.id === wanted);
  if (direct) return direct;

  const hasProgrammes = arrify(guide.programmes).some((p) => p['@_channel'] === wanted);
  if (hasProgrammes) {
    return {
      id: wanted,
      names: [preferredName || wanted],
      raw: { '@_id': wanted, 'display-name': [preferredName || wanted] }
    };
  }
  return null;
}

export { quickHash };

// ---- manual-match overrides (protected from auto-refresh) -----------------
//
// runAutoRefresh (below) re-matches every channel from scratch on every
// scheduled run. Without this, any tvg-id/logo a user manually confirmed
// or corrected in the interactive UI gets silently re-guessed — and
// potentially overwritten with something worse — on the very next run,
// with no visible warning that anything changed. Captured at publish time
// (every currently-manual link, keyed by the channel's raw M3U name — the
// only reasonably stable identifier available before a channel has been
// matched at all, since a manual fix is often precisely because the
// incoming tvg-id was empty or wrong) and consulted before search on every
// subsequent auto-refresh run.
function planKey(slug) {
  return `plan:${slug}`;
}

/** Every channel's match at the last publish, keyed by raw M3U channel name. */
export async function getChannelPlan(store, slugInput) {
  const slug = slugify(slugInput);
  if (!slug) return {};
  return (await store.getStale(planKey(slug))) || {};
}

export async function getChannelOverrides(store, slugInput) {
  const slug = slugify(slugInput);
  if (!slug) return {};
  return (await store.getStale(`overrides:${slug}`)) || {};
}

// ---- custom logo uploads ---------------------------------------------------
//
// The best-scoring match for a channel (public catalog, a custom EPG, or a
// TMDB poster) is sometimes just wrong — e.g. a 24/7 EPG entry that carries
// a generic/placeholder logo unrelated to the actual movie/show it's
// looping. This lets a user upload their own image instead of being stuck
// with whatever the matched source happened to have, without needing to
// host it externally themselves: the image is stored (same store as
// published files) and served back from a small, stable same-origin URL.

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB decoded
const ALLOWED_LOGO_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function genLogoId() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function uploadLogoAsset(store, { imageBase64, contentType }) {
  if (!imageBase64 || !contentType) {
    throw new Error('imageBase64 and contentType are required.');
  }
  if (!ALLOWED_LOGO_CONTENT_TYPES.has(contentType)) {
    throw new Error('Unsupported image type — use PNG, JPEG, WebP or GIF.');
  }
  // Base64 is ~4/3 the size of the decoded bytes; check before decoding
  // anything so an oversized upload fails fast and cheap.
  if (imageBase64.length > (MAX_LOGO_BYTES * 4) / 3 + 100) {
    throw new Error('Image too large (2MB limit).');
  }

  const id = genLogoId();
  // strict: returning a URL for an image that was never stored is worse than
  // failing the upload, since the channel would then point at a 404 logo.
  await store.set(`logo-asset:${id}`, { contentType, imageBase64 }, { strict: true, ttlSeconds: null });
  return { id, url: `/logo/${id}` };
}

export async function getLogoAsset(store, idInput) {
  const id = (idInput || '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  return store.getStale(`logo-asset:${id}`);
}

// ---- scheduled auto-refresh ------------------------------------------------
//
// Lets a published slug keep itself up to date on its own: given an M3U
// *URL* (not a one-off upload) plus the same match settings as an
// interactive session, periodically re-fetch, re-match every channel, and
// re-publish under the same slug. Config is stored via the same
// hosted-files store, one JSON blob per slug.

const REFRESH_INTERVALS_MS = {
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000
};

// The scheduler ticks on the hour, and a run finishes a few seconds (or a few
// minutes) *after* the tick that triggered it. Without a tolerance, a "24h"
// config anchored at 17:02 is not due at the next day's 17:00 tick
// (23h58m < 24h), so it slips to 18:00 — and then slips another hour the day
// after that, walking around the clock a hour per day. A tolerance smaller
// than the tick interval stops the drift without ever double-running.
const REFRESH_DUE_TOLERANCE_MS = 5 * 60 * 1000;
// A failed run is retried on the next hourly tick rather than waiting a full
// interval (or until tomorrow for a fixed-time config): a guide only covers a
// few days, so one bad night shouldn't cost a day of schedule.
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

const DEFAULT_REFRESH_TIME_ZONE = 'UTC';

const REFRESH_CONFIG_PREFIX = 'refresh-config:';
const MANIFEST_PREFIX = 'hosted:';
const MANIFEST_SUFFIX = ':manifest';

/**
 * Storage key for a slug's auto-refresh config. Centralised so the writer,
 * the reader and the enumerator can never drift apart — a "saved but
 * unreadable" config is indistinguishable from a missing one from the UI.
 * @param {string} slug
 */
export function refreshConfigKey(slug) {
  return `${REFRESH_CONFIG_PREFIX}${slug}`;
}

export async function saveRefreshConfig(hostedStore, input) {
  const slug = slugify(input.slug);
  if (!slug) throw new Error('A valid slug is required.');
  if (!input.m3uUrl || !input.m3uUrl.trim()) throw new Error('m3uUrl is required.');
  if (input.intervalKey && !REFRESH_INTERVALS_MS[input.intervalKey]) {
    throw new Error('intervalKey must be one of: 6h, 12h, 24h.');
  }

  const dailyAtHour = input.dailyAtHour === undefined || input.dailyAtHour === null || input.dailyAtHour === ''
    ? null
    : Number(input.dailyAtHour);
  if (dailyAtHour !== null && (!Number.isInteger(dailyAtHour) || dailyAtHour < 0 || dailyAtHour > 23)) {
    throw new Error('dailyAtHour must be a whole hour from 0 to 23.');
  }
  const timeZoneInput = (input.timeZone || '').trim() || null;
  if (timeZoneInput && !isValidTimeZone(timeZoneInput)) {
    throw new Error(`Unknown time zone: ${timeZoneInput}.`);
  }

  const existing = await hostedStore.getStale(`refresh-config:${slug}`);
  const config = {
    slug,
    m3uUrl: input.m3uUrl.trim(),
    // Omitted means "leave it alone", not "clear it": a caller that only wants
    // to change the schedule (or the scheduler re-saving after a run) must not
    // silently drop the user's custom guide sources. Sending '' still clears.
    customGuideUrl: input.customGuideUrl === undefined || input.customGuideUrl === null
      ? (existing?.customGuideUrl || null)
      : ((String(input.customGuideUrl) || '').trim() || null),
    // A fixed time-of-day and a rolling interval are mutually exclusive: the
    // fixed time wins, so switching modes can't leave two schedules behind.
    intervalKey: dailyAtHour !== null ? null : (input.intervalKey || null),
    dailyAtHour,
    timeZone: dailyAtHour !== null ? (timeZoneInput || DEFAULT_REFRESH_TIME_ZONE) : null,
    createdAt: existing?.createdAt || Date.now(),
    lastRunAt: existing?.lastRunAt || null,
    lastRunStatus: existing?.lastRunStatus || null,
    lastRunError: existing?.lastRunError || null,
    lastRunChannelCount: existing?.lastRunChannelCount || null,
    lastRunGuideCount: existing?.lastRunGuideCount || null,
    lastRunLogoCount: existing?.lastRunLogoCount || null,
    lastRunOverrideCount: existing?.lastRunOverrideCount || null,
    lastRunProgramCount: existing?.lastRunProgramCount || null,
    lastRunCurrentOrFutureCount: existing?.lastRunCurrentOrFutureCount || null,
    lastRunPublishWarnings: existing?.lastRunPublishWarnings || null,
    lastRunPublishedVersion: existing?.lastRunPublishedVersion || null,
    lastRunErrorCode: existing?.lastRunErrorCode || null
  };

  // Saved with no expiry: an auto-refresh config is the only thing standing
  // between a published guide and silent expiry, so it must not quietly
  // disappear on its own (it used to inherit 30-day TTL semantics).
  await hostedStore.set(refreshConfigKey(slug), config, { strict: true, ttlSeconds: null });
  return config;
}

export async function getRefreshConfig(hostedStore, slugInput) {
  const slug = slugify(slugInput);
  if (!slug) return null;
  return hostedStore.getStale(refreshConfigKey(slug));
}

/**
 * Every saved auto-refresh config in the store. Enumerated from storage
 * rather than a separate index, so a config that exists is always seen by the
 * scheduler (an index that drifts is how "registered but never executed").
 * @param {Object} store
 */
export async function listRefreshConfigs(store) {
  const entries = await store.list(REFRESH_CONFIG_PREFIX);
  return entries
    .map((entry) => entry.data)
    .filter((config) => config && config.slug)
    .sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}

/**
 * Safe description of a slug's refresh schedule, for the UI/health payload.
 *
 * `paused` is deliberately distinct from `enabled: false`: a config can be
 * saved with intervalKey null, which stores fine and is then never due —
 * the single most likely way for someone to believe auto-refresh is on when
 * it is not (and exactly why the field exists rather than a bare boolean).
 * @param {Object|null} config
 * @param {number} [now]
 */
export function describeRefreshSchedule(config, now = Date.now()) {
  if (!config) {
    return {
      configured: false,
      enabled: false,
      paused: false,
      mode: 'off',
      intervalKey: null,
      intervalMs: null,
      dailyAtHour: null,
      timeZone: DEFAULT_REFRESH_TIME_ZONE,
      lastRunAt: null,
      nextRunAt: null,
      due: false,
      lastRunStatus: null,
      lastRunError: null,
      lastRunErrorCode: null
    };
  }
  const dailyAtHour = Number.isInteger(config.dailyAtHour) ? config.dailyAtHour : null;
  const timeZone = config.timeZone && isValidTimeZone(config.timeZone) ? config.timeZone : DEFAULT_REFRESH_TIME_ZONE;
  const intervalMs = dailyAtHour === null && config.intervalKey ? REFRESH_INTERVALS_MS[config.intervalKey] : null;
  const mode = dailyAtHour !== null ? 'daily-at' : intervalMs ? 'interval' : 'off';
  const effective = { ...config, dailyAtHour, timeZone };
  let nextRunAt = null;
  if (mode === 'interval' && config.lastRunAt) nextRunAt = new Date(config.lastRunAt + intervalMs).toISOString();
  if (mode === 'daily-at') nextRunAt = nextDailyAtRun(effective, now);
  return {
    configured: true,
    enabled: mode !== 'off',
    paused: mode === 'off',
    mode,
    intervalKey: mode === 'interval' ? config.intervalKey : null,
    intervalMs: intervalMs || null,
    dailyAtHour,
    timeZone,
    lastRunAt: config.lastRunAt || null,
    nextRunAt,
    due: isRefreshDue(effective, now),
    lastRunStatus: config.lastRunStatus || null,
    lastRunError: config.lastRunError || null,
    lastRunErrorCode: config.lastRunErrorCode || null
  };
}

// How long past its interval a config may be before that is treated as evidence
// the scheduler itself is not running rather than as normal jitter. One tick
// (an hour on Cloudflare) plus slack, so a config saved moments ago and waiting
// for the next tick is not reported as a failure.
const AUTO_REFRESH_OVERDUE_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * Is an enabled config past due by more than the scheduler's tick, i.e. the
 * refresh that should have happened hasn't? This is the signal that separates
 * "nothing is configured" from "something is configured and the thing that
 * runs it is dead" — a missing Cron Trigger looks exactly like a working
 * schedule until you compare the clock against `lastRunAt`.
 * @param {Object|null} config
 * @param {Object} schedule from describeRefreshSchedule
 * @param {number} now
 */
function isAutoRefreshOverdue(config, schedule, now) {
  if (!config || !schedule?.enabled) return false;
  if (schedule.lastRunAt) return now - schedule.lastRunAt > schedule.intervalMs + AUTO_REFRESH_OVERDUE_GRACE_MS;
  // Enabled but never run at all: after the grace period, the tick is not
  // reaching this config (newly saved configs are due immediately by design).
  return config.createdAt ? now - config.createdAt > AUTO_REFRESH_OVERDUE_GRACE_MS : false;
}

/**
 * Is this an IANA time zone the runtime understands? (Workers and Node both
 * ship full ICU, so no time-zone database of our own is needed.)
 * @param {string} timeZone
 */
export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Calendar/clock parts for an instant in a specific zone. Used to answer "what
 * time is it *there*, where the user is", which is the only way a chosen
 * time-of-day can mean what they meant regardless of where the Worker runs.
 * @param {number} ms
 * @param {string} [timeZone]
 */
export function zonedParts(ms, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || DEFAULT_REFRESH_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    // "Which calendar day is it there?" — the unit a once-a-day run is keyed on.
    dayKey: `${parts.year}-${parts.month}-${parts.day}`
  };
}

/**
 * A fixed-time config runs on the first hourly check *inside* the chosen hour,
 * and only once per local calendar day.
 *
 * "Once per local day" rather than an exact timestamp comparison is deliberate:
 * it needs no offset arithmetic (so it survives DST changes), and it means a
 * manual "Refresh Now" earlier that day counts as that day's run instead of
 * being followed by a second one an hour later.
 *
 * Note the tick is hourly, so the run lands within the hour you pick — on the
 * hour for whole-hour zones, at :30 for half-hour zones like Asia/Kolkata.
 */
function isDailyAtDue(config, now) {
  const timeZone = config.timeZone || DEFAULT_REFRESH_TIME_ZONE;
  const local = zonedParts(now, timeZone);
  if (local.hour !== config.dailyAtHour) return false;
  if (!config.lastRunAt) return true;
  return zonedParts(config.lastRunAt, timeZone).dayKey !== local.dayKey;
}

/**
 * When a fixed-time config will next run, as an ISO timestamp (approximate to
 * the top of the chosen hour; the actual run is the first tick inside it).
 */
function nextDailyAtRun(config, now) {
  const timeZone = config.timeZone || DEFAULT_REFRESH_TIME_ZONE;
  const local = zonedParts(now, timeZone);
  let deltaHours = (config.dailyAtHour - local.hour + 24) % 24;
  const ranToday = config.lastRunAt ? zonedParts(config.lastRunAt, timeZone).dayKey === local.dayKey : false;
  if (deltaHours === 0 && ranToday) deltaHours = 24;
  const msIntoHour = local.minute * 60000 + local.second * 1000 + (now % 1000);
  return new Date(now + deltaHours * 3600000 - msIntoHour).toISOString();
}

function isFailureRetryDue(config, now) {
  return config.lastRunStatus === 'error'
    && Number.isFinite(config.lastRunAt)
    && now - config.lastRunAt >= RETRY_AFTER_FAILURE_MS - REFRESH_DUE_TOLERANCE_MS;
}

export function isRefreshDue(config, now = Date.now()) {
  if (!config) return false;
  if (Number.isInteger(config.dailyAtHour)) return isDailyAtDue(config, now) || isFailureRetryDue(config, now);
  if (!config.intervalKey) return false;
  const intervalMs = REFRESH_INTERVALS_MS[config.intervalKey];
  if (!intervalMs) return false;
  if (!config.lastRunAt) return true;
  if (isFailureRetryDue(config, now)) return true;
  return now - config.lastRunAt >= intervalMs - REFRESH_DUE_TOLERANCE_MS;
}

/**
 * If `url` is this deployment's own published playlist (/iptv/<slug>.m3u on
 * one of `selfHosts`), return that slug. A Worker can't fetch its own custom
 * domain (Cloudflare answers 522), so such a source must be read from storage.
 */
export function ownPlaylistSlug(url, selfHosts = []) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hosts = selfHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean);
  if (!hosts.includes(parsed.hostname.toLowerCase())) return null;
  const match = parsed.pathname.match(/^\/iptv\/([^/]+)\.m3u$/i);
  return match ? decodeURIComponent(match[1]) : null;
}

async function readRefreshSourcePlaylist(hostedStore, url, selfHosts) {
  const ownSlug = ownPlaylistSlug(url, selfHosts);
  if (ownSlug) {
    const content = await getHostedFile(hostedStore, ownSlug, 'playlist');
    if (!content) {
      throw Object.assign(new Error(`No playlist is published under "${ownSlug}" to refresh from.`), { code: 'REFRESH_SOURCE_NOT_PUBLISHED' });
    }
    return content;
  }
  return fetchTextMaybeGzip(url);
}

/**
 * Build the playlist + guide pair for a lineup from resolved matches: manual
 * overrides first, then the saved plan, then (only when allowed) a search.
 * Guides are streamed and filtered to the wanted channels, so this stays
 * within a Worker's CPU and memory limits when no search is needed. Shared by
 * Publish and the scheduled refresh, so both produce the same files.
 */
export async function buildFromPlan(cache, apiKey, { channels, overrides = {}, plan = {}, customGuideUrl = '', searchAll = false, baseXml = null, now = Date.now() }) {
  const usePlan = Object.keys(plan).length > 0 && !searchAll;
  const links = [];
  let guideCount = 0;
  let logoCount = 0;
  let failedCount = 0;
  let overrideCount = 0;
  let planCount = 0;
  let unplannedCount = 0;

  // Bounded concurrency: enough to not take forever on a large lineup,
  // low enough to stay a reasonable citizen of both the target hosts
  // and (on Cloudflare) the CPU-time budget for one invocation.
  await runWithConcurrency(channels, 5, async (channel) => {
    const override = overrides[channel.name];
    if (override) {
      // A manually-confirmed match is used as-is, never re-searched —
      // that's the entire point (see getChannelOverrides above).
      links.push({ ...override, channelIndex: channel.index });
      overrideCount += 1;
      if (override.canMergeGuide) guideCount += 1;
      else logoCount += 1;
      return;
    }

    if (usePlan) {
      const planned = plan[channel.name];
      if (!planned) {
        // New since the last publish: left as the playlist has it. Match it
        // in the app and publish to include it.
        unplannedCount += 1;
        return;
      }
      planCount += 1;
      if (!planned.channelId) return; // deliberately "None" at publish time
      links.push({ ...planned, channelIndex: channel.index });
      if (planned.canMergeGuide) guideCount += 1;
      else logoCount += 1;
      return;
    }

    try {
      const result = await searchChannel(cache, apiKey, {
        channelName: channel.name,
        tvgId: channel.attrs?.['tvg-id'] || '',
        groupTitle: channel.attrs?.['group-title'] || '',
        maxSources: MAX_SOURCES_PER_REQUEST,
        customGuideUrl: customGuideUrl || ''
      });

      const link = pickBestLink(result.matches, channel);
      if (link) {
        links.push(link);
        if (link.canMergeGuide) guideCount += 1;
        else logoCount += 1;
      }
    } catch {
      failedCount += 1;
    }
  });

  // 24/7 channels (a film or show on a loop) have no real schedule anywhere.
  // Any that end up without programmes get a generated one below; one with no
  // id at all is given one here, so the playlist and guide can be joined.
  const twentyFourSeven = [];
  for (const channel of channels) {
    if (!detectTwentyFourSeven(channel.name, channel.attrs?.['group-title'] || '')) continue;
    let link = links.find((candidate) => candidate.channelIndex === channel.index) || null;
    const tvgId = String(channel.attrs?.['tvg-id'] || '').trim();
    if (!link?.channelId && !tvgId) {
      link = {
        channelIndex: channel.index,
        channelId: `247.${slugify(channel.name) || channel.index}`,
        channelName: twentyFourSevenTitle(channel.name),
        logoUrl: channel.attrs?.['tvg-logo'] || null,
        canMergeGuide: false
      };
      links.push(link);
    }
    twentyFourSeven.push({ channel, link, channelId: link?.channelId || tvgId });
  }

  const { m3u } = await exportM3u({ channels, links });

  // Group guide-backed links by guideUrl so a shared guide (e.g. one
  // custom EPG matching most of the lineup) is fetched and parsed once,
  // not once per channel that happens to resolve to it.
  const guideGroups = new Map();
  const identityLinks = [];
  for (const link of links) {
    if (link.canMergeGuide && link.guideUrl && link.channelId) {
      if (!guideGroups.has(link.guideUrl)) guideGroups.set(link.guideUrl, []);
      guideGroups.get(link.guideUrl).push(link);
    } else if (link.logoUrl || link.tmdb) {
      identityLinks.push(link);
    }
  }

  const base = parseXmlTv(baseXml || emptyXmlTvStub()).tv;
  base.channel = arrify(base.channel);
  base.programme = arrify(base.programme);

  for (const [guideUrl, guideLinks] of guideGroups) {
    try {
      const subset = await fetchGuideSubset(guideUrl, guideLinks.map((link) => link.channelId));
      const guide = parseXmlTv(subset.xml);

      for (const link of guideLinks) {
        // Same contract as mergeGuide: only an exact id match may add a
        // channel node, because the M3U already carries this id as its
        // tvg-id (see resolveGuideChannel).
        const matchedChannel = resolveGuideChannel(guide, link.channelId, link.channelName);
        if (!matchedChannel) continue;

        const existingIdx = base.channel.findIndex((c) => c['@_id'] === matchedChannel.id);
        let channelNode;
        if (existingIdx === -1) {
          channelNode = matchedChannel.raw;
          if (!channelNode['display-name']) channelNode['display-name'] = [link.channelName || matchedChannel.id];
          base.channel.push(channelNode);
        } else {
          channelNode = base.channel[existingIdx];
        }
        if (link.logoUrl) channelNode.icon = { '@_src': link.logoUrl };

        // Replace, never append: a base guide may already hold (older)
        // programmes for this id.
        if (baseXml) base.programme = base.programme.filter((p) => p['@_channel'] !== matchedChannel.id);
        for (const programme of guide.programmes.filter((p) => p['@_channel'] === matchedChannel.id)) {
          base.programme.push(programme);
        }
      }
    } catch {
      failedCount += guideLinks.length;
    }
  }

  for (const link of identityLinks) {
    let channelNode = base.channel.find((c) => c['@_id'] === link.channelId);
    if (!channelNode) {
      channelNode = { '@_id': link.channelId, 'display-name': [link.channelName || link.channelId] };
      base.channel.push(channelNode);
    }
    const logoUrl = link.logoUrl || (link.tmdb ? link.tmdb.posterUrl : null);
    if (logoUrl) channelNode.icon = { '@_src': logoUrl };

    if (link.synthesize) {
      base.programme = base.programme.filter((p) => p['@_channel'] !== link.channelId);
      base.programme.push(...synthesizeSchedule(link.channelId, {
        title: link.tmdb?.title || link.channelName || link.channelId,
        description: link.tmdb?.overview || null
      }, now));
    }
  }

  let synthesizedCount = 0;
  const withProgrammes = new Set(base.programme.map((programme) => programme['@_channel']));
  for (const { channel, link, channelId } of twentyFourSeven) {
    if (!channelId || withProgrammes.has(channelId)) continue;
    const title = link?.tmdb?.title || twentyFourSevenTitle(channel.name);
    let channelNode = base.channel.find((node) => node['@_id'] === channelId);
    if (!channelNode) {
      channelNode = { '@_id': channelId, 'display-name': [channel.name] };
      base.channel.push(channelNode);
    }
    const logoUrl = link?.logoUrl || link?.tmdb?.posterUrl || channel.attrs?.['tvg-logo'] || null;
    if (logoUrl && !channelNode.icon) channelNode.icon = { '@_src': logoUrl };
    base.programme.push(...synthesizeSchedule(channelId, { title, description: link?.tmdb?.overview || null }, now));
    withProgrammes.add(channelId);
    synthesizedCount += 1;
  }

  return {
    m3u,
    xml: buildXmlTv(base),
    counts: { guideCount, logoCount, failedCount, overrideCount, planCount, unplannedCount, synthesizedCount }
  };
}

const SYNTH_BLOCK_MS = 3 * 60 * 60 * 1000;
const SYNTH_AHEAD_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * A placeholder schedule for a channel with no real one: back-to-back 3-hour
 * blocks from the current block to four days ahead, tagged "24/7" so players
 * and this app can tell it's generated (and so it isn't counted as real
 * schedule when judging freshness). Regenerated on every renewal.
 */
function synthesizeSchedule(channelId, { title, description }, now) {
  const programmes = [];
  const first = Math.floor(now / SYNTH_BLOCK_MS) * SYNTH_BLOCK_MS;
  const desc = description || `${title}, playing around the clock. This channel has no published schedule, so this guide entry is generated.`;
  for (let start = first; start < now + SYNTH_AHEAD_MS; start += SYNTH_BLOCK_MS) {
    programmes.push({
      '@_channel': channelId,
      '@_start': formatXmltvDate(new Date(start)),
      '@_stop': formatXmltvDate(new Date(start + SYNTH_BLOCK_MS)),
      title: [{ '#text': title, '@_lang': 'en' }],
      desc: [{ '#text': desc, '@_lang': 'en' }],
      category: [{ '#text': '24/7', '@_lang': 'en' }]
    });
  }
  return programmes;
}

export async function runAutoRefresh(cache, hostedStore, apiKey, config, options = {}) {
  const runAt = options.now ?? Date.now();
  try {
    const m3uText = await readRefreshSourcePlaylist(hostedStore, config.m3uUrl, options.selfHosts || []);
    const channels = parseM3U(m3uText);
    const overrides = await getChannelOverrides(hostedStore, config.slug);
    const plan = await getChannelPlan(hostedStore, config.slug);
    const hasPlan = Object.keys(plan).length > 0;
    // Re-searching every channel costs ~60s CPU and ~600MB for a 250-channel
    // lineup — far past a Worker's limits. With a plan, the refresh only renews
    // schedules; without one, a caller that can't afford a search fails
    // clearly (and the current guide stays live) instead of crashing.
    if (!hasPlan && options.requirePlan) {
      throw Object.assign(
        new Error('This slug has no saved channel plan yet. Open the app, load your session, and press Publish once — scheduled refreshes use that plan from then on.'),
        { code: 'REFRESH_PLAN_MISSING' }
      );
    }

    const { m3u, xml: mergedXml, counts } = await buildFromPlan(cache, apiKey, {
      channels,
      overrides,
      plan,
      customGuideUrl: config.customGuideUrl || '',
      searchAll: !hasPlan
    });
    const { guideCount, logoCount, failedCount, overrideCount, planCount, unplannedCount } = counts;


    // expectProgrammes: guide-backed channels were matched this run, so a
    // guide with no programmes — or one whose programmes have all already
    // ended — is a failed run, not a successful logo-only publication. This
    // is the check that stops a bad run from replacing the last valid guide
    // (and is the exact production failure it was added for: a published
    // guide that ages out still serves 200 and still looks fine everywhere
    // except in the player).
    const publication = await publishFiles(hostedStore, config.slug, {
      m3uContent: m3u,
      xmlContent: mergedXml,
      expectProgrammes: guideCount > 0
    });

    const updated = {
      ...config,
      lastRunAt: runAt,
      lastRunStatus: 'ok',
      lastRunError: null,
      lastRunErrorCode: null,
      lastRunChannelCount: channels.length,
      lastRunGuideCount: guideCount,
      lastRunLogoCount: logoCount,
      lastRunFailedCount: failedCount,
      lastRunOverrideCount: overrideCount,
      lastRunPlanCount: planCount,
      lastRunUnplannedCount: unplannedCount,
      lastRunProgramCount: publication.metrics.epgPrograms,
      lastRunCurrentOrFutureCount: publication.metrics.epgCurrentOrFuturePrograms,
      lastRunPublishWarnings: publication.warnings.map((w) => w.code),
      lastRunPublishedVersion: publication.version
    };
    await hostedStore.set(refreshConfigKey(config.slug), updated, { strict: true, ttlSeconds: null });
    logEvent('epg.autoRefresh.completed', {
      slugHash: slugHash(config.slug),
      channelCount: channels.length,
      guideCount,
      logoCount,
      failedCount,
      programCount: publication.metrics.epgPrograms
    });
    return updated;
  } catch (error) {
    const updated = {
      ...config,
      lastRunAt: runAt,
      lastRunStatus: 'error',
      lastRunError: error.message,
      lastRunErrorCode: error.code || null
    };
    try {
      await hostedStore.set(refreshConfigKey(config.slug), updated, { strict: true, ttlSeconds: null });
    } catch (storeError) {
      logEvent('epg.autoRefresh.statusWrite.failed', { slugHash: slugHash(config.slug), error: storeError.message }, 'error');
    }
    logEvent('epg.autoRefresh.failed', { slugHash: slugHash(config.slug), errorCode: error.code || null, error: error.message }, 'error');
    throw error;
  }
}

// ---- scheduled tick ---------------------------------------------------------
//
// One shared implementation of "run every config that is actually due", used
// by Cloudflare's cron trigger and by the local Node scheduler in server.js.
// Before this existed, only the Cloudflare Worker ever called runAutoRefresh
// from a background job, so a self-hosted deployment silently never refreshed
// anything — the config saved, the UI said it was saved, and nothing ran.

/**
 * Run every auto-refresh config that is due. Never throws for a single slug's
 * failure: one bad lineup must not stop every other slug from refreshing.
 * @param {Object} cache EPG source cache adapter
 * @param {Object} hostedStore hosted-files store adapter
 * @param {string} apiKey TMDB API key (may be '')
 * @param {{now?: number, maxRuns?: number}} [options]
 * @returns {Promise<{checked: number, due: number, ran: number, failed: number, results: Array}>}
 */
export async function runDueAutoRefreshes(cache, hostedStore, apiKey, options = {}) {
  const now = options.now ?? Date.now();
  const maxRuns = options.maxRuns ?? 25;
  const configs = await listRefreshConfigs(hostedStore);
  const results = [];
  let due = 0;
  let ran = 0;
  let failed = 0;

  for (const config of configs) {
    if (ran >= maxRuns) {
      results.push({ slug: config.slug, ran: false, reason: 'run-budget-exhausted' });
      continue;
    }
    // A config with no intervalKey is stored but never due — reported as
    // paused rather than skipped silently, so it shows up as a warning.
    if (!isRefreshDue(config, now)) {
      results.push({ slug: config.slug, ran: false, reason: config.intervalKey ? 'not-due' : 'paused' });
      continue;
    }
    due += 1;
    // `ran` counts attempts, `failed` the subset that errored: "ran 2, 1
    // failed" is what a reader needs, not "ran 1" while two configs were due.
    ran += 1;
    try {
      await runAutoRefresh(cache, hostedStore, apiKey, config, { now, selfHosts: options.selfHosts, requirePlan: options.requirePlan });
      results.push({ slug: config.slug, ran: true, status: 'ok' });
    } catch (error) {
      failed += 1;
      results.push({ slug: config.slug, ran: true, status: 'error', errorCode: error.code || null });
    }
  }

  logEvent('epg.autoRefresh.tick', { checked: configs.length, due, ran, failed });
  return { checked: configs.length, due, ran, failed, results };
}

// ---- freshness dashboard ----------------------------------------------------
//
// The outage this exists to prevent: a guide is published once, nothing ever
// re-publishes it, and a few days later every programme in it has already
// ended. The endpoints still return 200 and the guide is still perfectly
// valid XMLTV — only the viewer sees anything wrong. So every published slug
// is inspected for two independent things: how much schedule it has left, and
// whether anything is scheduled to renew it.

const FRESHNESS_WARNING_MESSAGES = {
  GUIDE_EXPIRED: 'Every programme in this guide has already ended — players will show no EPG for any channel. Republish it now.',
  GUIDE_ENDING_SOON: 'This guide\u2019s schedule runs out within 12 hours. Republish it, or enable auto-refresh, before then.',
  GUIDE_NO_PROGRAMMES: 'This guide contains no programmes at all (channel/logo data only).',
  GUIDE_MISSING: 'No guide is published for this slug — players will show a playlist with no EPG.',
  NO_AUTO_REFRESH: 'Nothing is scheduled to renew this guide, so it will expire and every channel will lose its EPG once its last programme passes. Enable auto-refresh for this slug.',
  AUTO_REFRESH_PAUSED: 'An auto-refresh config is saved for this slug but its interval is Off, so it will never run. Choose an interval to actually keep the guide fresh.',
  AUTO_REFRESH_FAILING: 'The last auto-refresh run failed — the guide above is no longer being renewed. See the recorded error for which stage failed.',
  AUTO_REFRESH_OVERDUE: 'Auto-refresh is enabled for this slug but has not run when it was due — the scheduler may not be running. On Cloudflare, check that the Cron Trigger exists (Settings \u2192 Trigger events, schedule 0 * * * *); locally, check IPTV4U_NO_SCHEDULER is not set.',
  AUTO_REFRESH_NEVER_RAN: 'Auto-refresh is enabled for this slug but has never run. If this persists, the scheduler is not executing: on Cloudflare, confirm the Cron Trigger exists (Settings \u2192 Trigger events, schedule 0 * * * *).'
};

/**
 * @param {string} code
 * @param {Object} [extra]
 */
function freshnessWarning(code, extra = {}) {
  return { code, message: FRESHNESS_WARNING_MESSAGES[code] || code, ...extra };
}

/**
 * Health of every published slug, plus whether each is being kept fresh.
 *
 * Reads the live guide for each slug so the programme counts are true *now*
 * rather than a publish-time snapshot (pass `{deep: false}` to answer from
 * manifests alone, which is cheaper but can only judge freshness). Safe to
 * store/log either way — every field is a count, a timestamp or a slug.
 *
 * @param {Object} store hosted-files store adapter
 * @param {{now?: number, deep?: boolean}} [options]
 * @returns {Promise<{status: string, checkedAt: string, count: number, slugs: Array, warnings: Array}>}
 */
export async function assessAllPublishedHealth(store, options = {}) {
  const now = options.now ?? Date.now();
  const rows = [];

  // Group by slug rather than only looking for a manifest: a slug published
  // before manifests existed (or served from the legacy keys) is still a
  // published slug, and leaving it out of the dashboard would hide exactly
  // the guides most likely to have gone stale unnoticed.
  const manifests = new Map();
  const seen = new Set();
  if (typeof store.listNames === 'function') {
    // Names only, then just the small manifests: listing with values would
    // read every stored guide version (several MB each) on every call.
    for (const name of await store.listNames(MANIFEST_PREFIX)) {
      const slug = name.slice(MANIFEST_PREFIX.length).split(':')[0];
      if (slug) seen.add(slug);
    }
    for (const slug of seen) {
      const manifest = await store.getStale(manifestKey(slug));
      if (manifest) manifests.set(slug, manifest);
    }
  } else {
    for (const entry of await store.list(MANIFEST_PREFIX)) {
      const slug = entry.name.slice(MANIFEST_PREFIX.length).split(':')[0];
      if (!slug) continue;
      seen.add(slug);
      if (entry.name.endsWith(MANIFEST_SUFFIX) && entry.data) manifests.set(slug, entry.data);
    }
  }

  for (const slug of [...seen].sort()) {
    rows.push(await buildPublishedRow(store, slug, manifests.get(slug) || null, now, options));
  }

  // A slug can have a refresh config and no publication at all (a config
  // saved for a slug that was renamed, or a publication that never landed) —
  // that is worth surfacing too, since the user believes it is running.
  for (const config of await listRefreshConfigs(store)) {
    if (seen.has(config.slug)) continue;
    const schedule = describeRefreshSchedule(config, now);
    rows.push({
      slug: config.slug,
      published: false,
      status: 'missing',
      publishedAt: null,
      activeVersion: null,
      guideAgeMs: null,
      scheduleRemainingMs: null,
      latestProgramStop: null,
      expiry: { at: null, inMs: null, expired: false },
      hasGuide: false,
      guideChannels: null,
      programmes: null,
      currentOrFutureProgrammes: null,
      freshness: 'unknown',
      renewal: 'unpublished',
      attentionRank: 0,
      refresh: schedule,
      warnings: [
        freshnessWarning('NO_AUTO_REFRESH', {
          message: 'An auto-refresh config is saved for this slug, but nothing has been published under it yet.'
        })
      ]
    });
  }

  // Worst first, then by slug so the order is stable between calls.
  rows.sort((a, b) => (a.attentionRank - b.attentionRank) || String(a.slug).localeCompare(String(b.slug)));
  const warnings = rows.flatMap((row) => row.warnings.map((w) => ({ ...w, slug: row.slug })));

  // Scheduler-level health: the one failure mode no individual slug can
  // distinguish on its own. Every slug can look correctly "enabled" while the
  // thing that executes them is not running at all.
  const enabled = rows.filter((row) => row.refresh?.enabled);
  const neverRun = enabled.filter((row) => !row.refresh.lastRunAt).map((row) => row.slug);
  const overdue = rows.filter((row) => row.renewal === 'overdue').map((row) => row.slug);
  // Enabled, past its grace period, and still never executed — the only
  // evidence that the thing meant to run it is not running. A config saved
  // moments ago is *expected* to have no lastRunAt yet, so it must not be
  // counted here, or enabling auto-refresh would immediately cry wolf.
  const neverRanAndOverdue = enabled
    .filter((row) => row.renewal === 'overdue' && !row.refresh.lastRunAt)
    .map((row) => row.slug);
  const lastRunAt = enabled
    .map((row) => row.refresh.lastRunAt)
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || null;
  const scheduler = {
    enabledConfigs: enabled.length,
    pausedConfigs: rows.filter((row) => row.refresh?.paused).length,
    unconfigured: rows.filter((row) => row.refresh && !row.refresh.configured).length,
    neverRun,
    neverRanAndOverdue,
    overdue,
    lastRunAt,
    // true = evidence it runs, false = evidence it doesn't, null = no enabled
    // configs, or too soon to tell either way.
    //
    // A past lastRunAt is *not* sufficient for true: a manual "Refresh Now"
    // leaves one behind, so a scheduler that stopped three days ago would still
    // look alive. `overdue` is the reliable signal, because a run that is
    // attempted — successfully or not — always advances lastRunAt.
    observed: enabled.length === 0 || (!lastRunAt && neverRanAndOverdue.length === 0 && overdue.length === 0)
      ? null
      : neverRanAndOverdue.length > 0 || overdue.length > 0
        ? false
        : true
  };
  if (scheduler.observed === false) {
    warnings.push({
      code: 'SCHEDULER_NOT_OBSERVED',
      slug: null,
      message: `Auto-refresh is enabled but the scheduler is not running it (${(overdue.length ? overdue : neverRanAndOverdue).join(', ')}) — the guides will not be renewed. On Cloudflare, confirm the Cron Trigger exists (Settings \u2192 Trigger events, schedule 0 * * * *); locally, confirm IPTV4U_NO_SCHEDULER is not set.`
    });
  }

  // Instance health is about what is *published*. A saved auto-refresh config
  // with nothing published under it is worth flagging (degraded), but calling
  // a whole instance "invalid" because of one leftover config misreports every
  // guide on it — and "invalid" is reserved for content that is actually
  // broken.
  const publishedRows = rows.filter((row) => row.published);
  let status = 'healthy';
  if (publishedRows.some((row) => row.status === 'invalid')) status = 'invalid';
  else if (publishedRows.some((row) => row.status === 'stale')) status = 'stale';
  else if (rows.some((row) => row.status !== 'healthy')) status = 'degraded';

  return {
    status,
    checkedAt: new Date(now).toISOString(),
    count: rows.length,
    // A guide can be expired, expiring or unrenewed at the same time; these
    // three counts are what the dashboard banner summarises.
    attention: {
      expired: rows.filter((row) => row.freshness === 'expired').length,
      expiringSoon: rows.filter((row) => row.freshness === 'ending-soon').length,
      noRefresh: rows.filter((row) => row.refresh && !row.refresh.enabled).length,
      overdue: rows.filter((row) => row.renewal === 'overdue').length
    },
    scheduler,
    slugs: rows,
    warnings
  };
}

/**
 * @param {Object} store
 * @param {string} slug
 * @param {Object|null} manifest
 * @param {number} now
 */
async function buildPublishedRow(store, slug, manifest, now, options = {}) {
  const config = await store.getStale(refreshConfigKey(slug));
  const schedule = describeRefreshSchedule(config, now);

  // The manifest's `epgCurrentOrFuturePrograms` is a snapshot taken at publish
  // time, so it stays frozen at whatever it was then — it would still claim
  // "96 current/upcoming" about a guide in which every programme has ended.
  // The dashboard's whole purpose is not to lie about that, so the live guide
  // is read (this is an on-demand report, the same cost as the single-slug
  // health check) and the manifest is only the fallback when it cannot be.
  let analysis = null;
  let resolvedEpg = null;
  if (options.deep !== false) {
    try {
      resolvedEpg = await resolveHostedFile(store, slug, 'epg');
      if (resolvedEpg?.content) analysis = analyzeGuide(resolvedEpg.content, { now });
    } catch {
      // unreadable body — fall back to manifest-only freshness below
    }
  }

  // No guide at all is reported as "unknown", not as "no-programmes":
  // GUIDE_MISSING below says what is actually wrong, and this keeps the field
  // identical to what the single-slug health view reports for the same store.
  const hasGuide = !!analysis || !!manifest?.epgChannels;
  const freshness = !hasGuide ? 'unknown' : analysis ? guideFreshness(analysis, now) : manifestFreshness(manifest, now);
  const warnings = [];

  if (freshness === 'expired') warnings.push(freshnessWarning('GUIDE_EXPIRED'));
  else if (freshness === 'ending-soon') warnings.push(freshnessWarning('GUIDE_ENDING_SOON'));
  else if (freshness === 'no-programmes') warnings.push(freshnessWarning('GUIDE_NO_PROGRAMMES'));

  // A config that exists but is not being executed is a *different* failure
  // from no config at all: "enabled" alone is not evidence that anything ran,
  // so the two are reported separately rather than collapsed into one flag.
  const overdue = isAutoRefreshOverdue(config, schedule, now);
  if (schedule.paused) warnings.push(freshnessWarning('AUTO_REFRESH_PAUSED'));
  else if (!schedule.enabled) warnings.push(freshnessWarning('NO_AUTO_REFRESH'));
  else if (overdue) warnings.push(freshnessWarning('AUTO_REFRESH_OVERDUE', { neverRan: !schedule.lastRunAt }));
  else if (schedule.lastRunStatus === 'error') {
    warnings.push(freshnessWarning('AUTO_REFRESH_FAILING', {
      errorCode: schedule.lastRunErrorCode,
      error: schedule.lastRunError
    }));
  }

  const renewal = schedule.paused ? 'paused' : !schedule.enabled ? 'will-expire' : overdue ? 'overdue' : 'auto';
  // Manifest first; for a slug published before manifests, the stored write
  // time, so "Guide age" is a real number rather than "unknown" on a
  // deployment where every existing slug predates manifests.
  const publishedAt = manifest?.publishedAt || resolvedEpg?.publishedAt || null;
  const publishedAtMs = publishedAt ? Date.parse(publishedAt) : NaN;
  const latestStop = analysis?.latestStop || manifest?.latestProgramStop || null;
  const latestStopMs = latestStop ? Date.parse(latestStop) : NaN;
  const invalid = !!analysis && !analysis.validXml;
  if (invalid) warnings.unshift(...analysis.errors.map((e) => ({ code: e.code, message: e.message })));
  // A playlist published with no guide at all is a degraded slug, not an
  // invalid one — the same distinction the single-slug health view draws, so
  // the two views can't disagree about the same slug. (Calling it invalid also
  // used to happen purely because an unmeasurable freshness looked like a
  // failed validation.)
  if (!hasGuide) warnings.unshift(freshnessWarning('GUIDE_MISSING'));

  return {
    slug,
    published: true,
    status: healthStatus({
      valid: !invalid,
      freshness,
      warnings: warnings.length,
      matched: manifest?.identifierMatchCount ?? 0,
      channels: analysis?.channelCount ?? manifest?.epgChannels ?? 0
    }),
    publishedAt,
    publishedAtSource: manifest?.publishedAt ? 'manifest' : (resolvedEpg?.publishedAtSource || null),
    activeVersion: manifest?.activeVersion || null,
    lastKnownGoodAvailable: !!manifest?.previousVersion,
    guideAgeMs: Number.isFinite(publishedAtMs) ? Math.max(0, now - publishedAtMs) : null,
    latestProgramStop: latestStop,
    scheduleRemainingMs: Number.isFinite(latestStopMs) ? latestStopMs - now : null,
    // The countdown the dashboard sorts and labels by: positive = time left,
    // negative = how long ago it ran out.
    expiry: {
      at: latestStop,
      inMs: Number.isFinite(latestStopMs) ? latestStopMs - now : null,
      expired: Number.isFinite(latestStopMs) && latestStopMs <= now
    },
    hasGuide,
    guideChannels: analysis?.channelCount ?? manifest?.epgChannels ?? null,
    programmes: analysis?.programmeCount ?? manifest?.epgPrograms ?? null,
    currentOrFutureProgrammes: analysis ? analysis.currentOrFutureProgrammes : null,
    freshness,
    // 'auto' = something will renew it; 'will-expire' = nothing will;
    // 'paused' = a config exists but can never be due; 'overdue' = the
    // scheduler is not running what it was told to.
    renewal,
    attentionRank: rankAttention({ freshness, renewal }),
    refresh: schedule,
    warnings
  };
}

/**
 * How urgently a published slug needs attention, as a sort key: broken first,
 * then about to break, then working-but-unrenewed, then healthy. Ordering the
 * dashboard by this is what puts the slug that has already failed at the top
 * instead of wherever its name happens to fall in the alphabet.
 * @param {{freshness: string, renewal: string}} state
 * @returns {number} 0 = worst
 */
export function rankAttention({ freshness, renewal }) {
  if (freshness === 'expired' || freshness === 'unknown') return 0;
  if (freshness === 'no-programmes') return 1;
  if (freshness === 'ending-soon') return 1;
  if (renewal === 'overdue') return 2;
  if (renewal !== 'auto') return 3;
  return 4;
}

export { slugify };

// ---- public (slug-masked) health report ------------------------------------
//
// A slug is the only thing protecting a published playlist, whose stream URLs
// usually carry provider credentials. The all-slugs report is public, so it
// must not list slug names: each is replaced by a salted id that can't be
// reversed by guessing short names. The salt is generated once per store.

const SLUG_ID_SALT_KEY = 'meta:slug-id-salt';

async function slugIdSalt(store) {
  const existing = await store.getStale(SLUG_ID_SALT_KEY);
  if (typeof existing === 'string' && existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await store.set(SLUG_ID_SALT_KEY, salt, { strict: true, ttlSeconds: null });
  return salt;
}

/** Salted, non-reversible id for a slug, as used in the public health report. */
export async function publicSlugId(store, slugInput) {
  const slug = slugify(slugInput);
  if (!slug) return null;
  return (await sha256Hex(`${await slugIdSalt(store)}\u0000${slug}`)).slice(0, 12);
}

/**
 * assessAllPublishedHealth, shallow (manifest metadata only — no guide bodies
 * are read) and with every slug name replaced by its public id.
 */
export async function publicHealthReport(store, options = {}) {
  const report = await assessAllPublishedHealth(store, { ...options, deep: false });
  const ids = new Map();
  for (const row of report.slugs) ids.set(row.slug, await publicSlugId(store, row.slug));
  const mask = (slug) => (slug ? ids.get(slug) ?? null : null);
  // A caller that already knows a slug (the app, for its own) gets that one
  // row's name back; nothing it didn't already know is revealed.
  const revealed = options.reveal ? slugify(options.reveal) : null;
  const nameIfKnown = (slug) => (slug && slug === revealed ? slug : null);
  const scheduler = { ...report.scheduler };
  for (const key of ['neverRun', 'neverRanAndOverdue', 'overdue']) {
    if (Array.isArray(scheduler[key])) scheduler[key] = scheduler[key].map(mask);
  }
  return redactUrls({
    ...report,
    slugs: report.slugs.map((row) => ({ ...row, slug: nameIfKnown(row.slug), id: mask(row.slug) })),
    warnings: (report.warnings || []).map((warning) => ({ ...warning, slug: nameIfKnown(warning.slug), id: mask(warning.slug) })),
    scheduler
  });
}

// Recorded run errors quote the URL that failed — which can be this app's own
// /iptv/<slug>.m3u or a provider guide URL with a private token in its path.
// The public report keeps only scheme and host.
function redactUrls(value) {
  const text = JSON.stringify(value).replace(/https?:\/\/[^\s"\\]+/g, (match) => {
    try {
      const url = new URL(match);
      return `${url.protocol}//${url.host}/…`;
    } catch {
      return '…';
    }
  });
  return JSON.parse(text);
}

/**
 * The Publish/Export build: one request that turns the raw playlist and the
 * app's per-channel plan into the final playlist + guide, instead of one
 * request per channel re-sending the whole guide each time. Never searches.
 */
export async function buildPublication(cache, apiKey, { m3uText, plan, overrides, baseXml } = {}) {
  if (typeof m3uText !== 'string' || !m3uText.trim()) {
    throw Object.assign(new Error('m3uText (the loaded playlist) is required.'), { status: 400, code: 'BUILD_PLAYLIST_MISSING' });
  }
  if (!plan || typeof plan !== 'object' || !Object.keys(plan).length) {
    throw Object.assign(new Error('plan (each channel’s match) is required.'), { status: 400, code: 'BUILD_PLAN_MISSING' });
  }
  if (m3uText.length > MAX_PUBLISHED_CONTENT_LENGTH || (typeof baseXml === 'string' && baseXml.length > MAX_PUBLISHED_CONTENT_LENGTH)) {
    throw Object.assign(new Error('File too large to build (15MB limit per file).'), { status: 413, code: 'CONTENT_TOO_LARGE' });
  }
  const channels = parseM3U(m3uText);
  return buildFromPlan(cache, apiKey, {
    channels,
    plan,
    overrides: overrides && typeof overrides === 'object' ? overrides : {},
    baseXml: typeof baseXml === 'string' && baseXml.trim() ? baseXml : null
  });
}
