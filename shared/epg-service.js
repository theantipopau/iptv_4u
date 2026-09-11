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
  buildLogoMap,
  searchIptvApi,
  parseCustomGuideUrls
} from './core.js';
import { fetchWithTimeout, fetchTextMaybeGzip, runWithConcurrency } from './fetch-utils.js';

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

export async function loadSourceChannels(cache, source) {
  const cached = await cache.get(`source:${source.id}`, SOURCE_CHANNELS_MAX_AGE);
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

  await cache.set(`source:${source.id}`, { channels });
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

  const all = [...workerMatches, ...apiMatches]
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

  const matchedChannel = guide.channels.find((c) => c.id === channelId) ||
    guide.channels.find((c) => c.names.some((n) => scoreMatch(preferredName || '', n) > 0.9));

  if (!matchedChannel) {
    const err = new Error(`Channel ${channelId} not found in selected guide.`);
    err.status = 404;
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

export async function publishFiles(store, slugInput, { m3uContent, xmlContent }) {
  const slug = slugify(slugInput);
  if (!slug) {
    throw new Error('A valid slug is required (letters, numbers, dashes).');
  }
  if (!m3uContent && !xmlContent) {
    throw new Error('Nothing to publish — provide m3uContent and/or xmlContent.');
  }
  if ((m3uContent && m3uContent.length > MAX_PUBLISHED_CONTENT_LENGTH) ||
      (xmlContent && xmlContent.length > MAX_PUBLISHED_CONTENT_LENGTH)) {
    throw new Error('File too large to publish (15MB limit per file).');
  }

  if (m3uContent) await store.set(`hosted:${slug}:m3u`, m3uContent);
  if (xmlContent) await store.set(`hosted:${slug}:xml`, xmlContent);

  return { slug };
}

export async function getHostedFile(store, slugInput, kind) {
  const slug = slugify(slugInput);
  if (!slug) return null;
  // Published content has no freshness window of its own — it's live
  // until explicitly republished — so always read via getStale.
  return store.getStale(`hosted:${slug}:${kind}`);
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

export async function saveRefreshConfig(hostedStore, input) {
  const slug = slugify(input.slug);
  if (!slug) throw new Error('A valid slug is required.');
  if (!input.m3uUrl || !input.m3uUrl.trim()) throw new Error('m3uUrl is required.');
  if (input.intervalKey && !REFRESH_INTERVALS_MS[input.intervalKey]) {
    throw new Error('intervalKey must be one of: 6h, 12h, 24h.');
  }

  const existing = await hostedStore.getStale(`refresh-config:${slug}`);
  const config = {
    slug,
    m3uUrl: input.m3uUrl.trim(),
    customGuideUrl: (input.customGuideUrl || '').trim() || null,
    intervalKey: input.intervalKey || null,
    createdAt: existing?.createdAt || Date.now(),
    lastRunAt: existing?.lastRunAt || null,
    lastRunStatus: existing?.lastRunStatus || null,
    lastRunError: existing?.lastRunError || null,
    lastRunChannelCount: existing?.lastRunChannelCount || null,
    lastRunGuideCount: existing?.lastRunGuideCount || null,
    lastRunLogoCount: existing?.lastRunLogoCount || null
  };

  await hostedStore.set(`refresh-config:${slug}`, config);
  return config;
}

export async function getRefreshConfig(hostedStore, slugInput) {
  const slug = slugify(slugInput);
  if (!slug) return null;
  return hostedStore.getStale(`refresh-config:${slug}`);
}

export function isRefreshDue(config, now = Date.now()) {
  if (!config || !config.intervalKey) return false;
  const intervalMs = REFRESH_INTERVALS_MS[config.intervalKey];
  if (!intervalMs) return false;
  if (!config.lastRunAt) return true;
  return now - config.lastRunAt >= intervalMs;
}

export async function runAutoRefresh(cache, hostedStore, apiKey, config) {
  try {
    const m3uText = await fetchTextMaybeGzip(config.m3uUrl);
    const channels = parseM3U(m3uText);

    const links = [];
    let guideCount = 0;
    let logoCount = 0;
    let failedCount = 0;

    // Bounded concurrency: enough to not take forever on a large lineup,
    // low enough to stay a reasonable citizen of both the target hosts
    // and (on Cloudflare) the CPU-time budget for one invocation.
    await runWithConcurrency(channels, 5, async (channel) => {
      try {
        const result = await searchChannel(cache, apiKey, {
          channelName: channel.name,
          tvgId: channel.attrs?.['tvg-id'] || '',
          groupTitle: channel.attrs?.['group-title'] || '',
          maxSources: MAX_SOURCES_PER_REQUEST,
          customGuideUrl: config.customGuideUrl || ''
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

    const base = parseXmlTv(emptyXmlTvStub()).tv;
    base.channel = arrify(base.channel);
    base.programme = arrify(base.programme);

    for (const [guideUrl, guideLinks] of guideGroups) {
      try {
        const guideXml = await fetchTextMaybeGzip(guideUrl);
        const guide = parseXmlTv(guideXml);

        for (const link of guideLinks) {
          const matchedChannel = guide.channels.find((c) => c.id === link.channelId) ||
            guide.channels.find((c) => c.names.some((n) => scoreMatch(link.channelName || '', n) > 0.9));
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
        const startDate = new Date();
        startDate.setUTCHours(0, 0, 0, 0);
        for (let i = 0; i < 3; i += 1) {
          const start = new Date(startDate.getTime() + i * 86400000);
          const stop = new Date(start.getTime() + 86400000);
          const programme = {
            '@_channel': link.channelId,
            '@_start': formatXmltvDate(start),
            '@_stop': formatXmltvDate(stop),
            title: [{ '#text': link.tmdb?.title || link.channelName || link.channelId, '@_lang': 'en' }],
            category: [{ '#text': '24/7', '@_lang': 'en' }]
          };
          if (link.tmdb?.overview) programme.desc = [{ '#text': link.tmdb.overview, '@_lang': 'en' }];
          base.programme.push(programme);
        }
      }
    }

    const mergedXml = buildXmlTv(base);
    await publishFiles(hostedStore, config.slug, { m3uContent: m3u, xmlContent: mergedXml });

    const updated = {
      ...config,
      lastRunAt: Date.now(),
      lastRunStatus: 'ok',
      lastRunError: null,
      lastRunChannelCount: channels.length,
      lastRunGuideCount: guideCount,
      lastRunLogoCount: logoCount,
      lastRunFailedCount: failedCount
    };
    await hostedStore.set(`refresh-config:${config.slug}`, updated);
    return updated;
  } catch (error) {
    const updated = { ...config, lastRunAt: Date.now(), lastRunStatus: 'error', lastRunError: error.message };
    await hostedStore.set(`refresh-config:${config.slug}`, updated);
    throw error;
  }
}

export { slugify };
