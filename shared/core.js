// Platform-agnostic parsing, scoring, and XMLTV logic — no fs, no Node
// built-ins, no Express. Shared between the local Node server (server.js)
// and the Cloudflare Worker (worker.js) so matching-logic fixes only need
// to land in one place.

import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  suppressEmptyNode: true
});

export function arrify(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// Given a channel's search-channel match list, pick the best one and turn
// it into the same "link" shape the frontend builds client-side — used
// server-side by the auto-refresh pipeline, which has no browser/DOM to
// run the frontend's copy of this decision in.
export function pickBestLink(matches, channel) {
  const best = (matches || [])[0];
  if (!best) return null;

  const isTmdb = best.sourceType === 'tmdb';
  const channelId = best.channelId ||
    (isTmdb ? `tmdb-${slugify(best.tmdb?.title || channel.name)}` : slugify(channel.name));

  return {
    channelIndex: channel.index,
    channelId,
    channelName: best.channelName || channel.name,
    source: best.source || '',
    logoUrl: best.logoUrl || null,
    guideUrl: best.guideUrl || null,
    canMergeGuide: !!best.canMergeGuide,
    tmdb: isTmdb ? best.tmdb : null,
    synthesize: isTmdb && !!best.canSynthesizeGuide,
    score: typeof best.score === 'number' ? best.score : null
  };
}

export function slugify(name) {
  return String(name || 'channel')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'channel';
}

// Accepts one URL per line (or comma-separated) so a user can combine
// more than one custom guide — e.g. their own provider's EPG plus a
// region-specific community guide that covers channels the provider's
// own guide doesn't.
export function parseCustomGuideUrls(text) {
  if (!text) return [];
  const urls = String(text)
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(urls));
}

export function formatXmltvDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`;
}

// ---- M3U parsing/serializing ---------------------------------------------

export function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let pending = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const attrMatches = line.matchAll(/([\w-]+)="([^"]*)"/g);
      for (const match of attrMatches) {
        attrs[match[1]] = match[2];
      }

      const commaIdx = line.indexOf(',');
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : `Channel ${channels.length + 1}`;
      pending = {
        index: channels.length,
        name,
        attrs,
        url: ''
      };
      continue;
    }

    if (pending && !line.startsWith('#')) {
      pending.url = line;
      channels.push(pending);
      pending = null;
    }
  }

  if (pending) {
    channels.push(pending);
  }

  return channels;
}

export function serializeM3U(channels) {
  const out = ['#EXTM3U'];
  for (const channel of channels) {
    const attrs = Object.entries(channel.attrs || {})
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`)
      .join(' ');
    const attrPart = attrs ? ` ${attrs}` : '';
    out.push(`#EXTINF:-1${attrPart},${channel.name || 'Unknown Channel'}`);
    out.push(channel.url || '');
  }
  return `${out.join('\n')}\n`;
}

// ---- XMLTV parsing/building -----------------------------------------------

export function parseXmlTv(xmlText) {
  const parsed = parser.parse(xmlText);
  const tv = parsed.tv || parsed.xmltv;
  if (!tv) {
    throw new Error('Invalid XMLTV document. Missing <tv> root node.');
  }

  const channels = arrify(tv.channel).map((channel) => {
    const names = arrify(channel['display-name']).map((n) => {
      if (typeof n === 'string') return n;
      if (n && typeof n['#text'] === 'string') return n['#text'];
      return '';
    }).filter(Boolean);

    return {
      id: channel['@_id'] || '',
      names,
      raw: channel
    };
  });

  const programmes = arrify(tv.programme);

  return { tv, channels, programmes };
}

export function buildXmlTv(tv) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ tv })}`;
}

export function emptyXmlTvStub() {
  return buildXmlTv({ '@_generator-info-name': 'iptv-4u', channel: [], programme: [] });
}

export function pickBestName(displayNames, fallback) {
  for (const item of displayNames || []) {
    if (typeof item === 'string' && item.trim()) return item.trim();
    if (item && typeof item['#text'] === 'string' && item['#text'].trim()) return item['#text'].trim();
  }
  return fallback || '';
}

export function normalizeWorkerUrl(baseUrl, value) {
  // Some worker.json files declare `channels`/`guide` as an object (e.g.
  // multiple language/quality variants) rather than a plain string path.
  // new URL() would silently coerce that via toString() into a garbage
  // ".../[object Object]" URL instead of failing — reject it outright.
  if (!value || typeof value !== 'string') return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

// ---- matching -------------------------------------------------------------

function containsAsWholeWord(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack);
}

function collapseAlnum(s) {
  return s.replace(/[^a-z0-9]/g, '');
}

// "ITV1" vs "ITV 1", "BBC1" vs "BBC 1" — a channel-number glued directly
// onto the name is an extremely common catalog convention that an M3U
// entry (or a different catalog) often writes with a space instead. Split
// on every letter<->digit boundary so both spellings tokenize identically,
// then strip quality-tag words a catalog name often carries that a query
// doesn't (or vice versa) — same list cleanTitleForLookup already strips
// from the query side, applied here to both sides so an incidental "HD"/
// "4K" suffix doesn't dilute an otherwise-exact match.
function normalizeForScoring(s) {
  return s
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/\b(fhd|uhd|hd|sd|4k|hevc|h265|h264)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function scoreMatch(needle, haystack) {
  const a = normalizeForScoring((needle || '').toLowerCase().trim());
  const b = normalizeForScoring((haystack || '').toLowerCase().trim());
  if (!a || !b) return 0;
  if (a === b) return 1;

  // A residual spacing/punctuation-only difference after normalization
  // (e.g. "Sky Sport1" vs "Sky-Sport 1") — neither whole-word containment
  // nor token overlap catches this (the tokens can still differ in how
  // they're split), but the identity is unambiguous.
  const collapsedA = collapseAlnum(a);
  const collapsedB = collapseAlnum(b);
  if (collapsedA && collapsedA === collapsedB) return 0.95;

  const tokensA = a.split(/[^a-z0-9]+/).filter(Boolean);
  const tokensB = b.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const aIsShorter = a.length <= b.length;
  const shorterStr = aIsShorter ? a : b;
  const longerStr = aIsShorter ? b : a;
  const shorterTokens = aIsShorter ? tokensA : tokensB;
  const longerTokens = aIsShorter ? tokensB : tokensA;

  // Containment is only a meaningful signal when the shorter side is a
  // whole word/phrase inside the longer one, not just any substring —
  // otherwise short titles like "Tron" or "Up" spuriously "match" any
  // channel whose name merely contains those letters mid-word (e.g.
  // "Tron" inside "Armstrong" or "Electron"). Very short strings (under 4
  // chars, e.g. "7", "Her") are excluded outright regardless.
  //
  // The score itself is the *fraction of the longer side's words* the
  // shorter side accounts for — not a flat "at least 0.65/0.75" floor.
  // A flat floor is exactly what let a channel literally named "Sport"
  // outrank a real identification for "Stan Sport AU Event 1", or a
  // channel named "Band" win over "Band of Brothers" — one matching word
  // out of five (or three) is a weak signal, not a strong one.
  //
  // The numerator is generic-word-weighted too, same as the token-overlap
  // fallback below — otherwise an alt_name like "History Channel
  // International" fully containing the query "History Channel" (2/3
  // words) can outscore the actual right channel just named "History"
  // (1/2 words), purely because "Channel" is a free word to match on.
  let score;
  if (shorterStr.length >= 4 && containsAsWholeWord(longerStr, shorterStr)) {
    const matchedWeight = shorterTokens.reduce((sum, t) => sum + genericTokenWeight(t), 0);
    score = matchedWeight / longerTokens.length;
  } else {
    const setB = new Set(tokensB);
    let overlap = 0;
    for (const token of tokensA) {
      if (setB.has(token)) overlap += genericTokenWeight(token);
    }
    score = overlap / Math.max(tokensA.length, tokensB.length);
  }

  // "Fox Sports 502" vs "Fox Sports 501" (or "ESPN" vs "ESPN2") share
  // everything except the one token that actually distinguishes them —
  // whether that surfaced via whole-word containment or plain token
  // overlap above. iptv-org's catalog only has a handful of the numbered
  // Fox Sports AU channels as dedicated entries (503, 505, 506) — query
  // for one that isn't (502, 504, 507, 508...) and "Fox"+"Sports" overlap
  // alone was enough to match the wrong numbered channel. A specific
  // number token present on one side and absent (or different) on the
  // other is a strong signal these are different channels, not weak
  // evidence to be outweighed by shared generic words.
  if (hasConflictingNumber(tokensA, tokensB)) {
    return Math.min(score, 0.3);
  }

  return score;
}

function hasConflictingNumber(tokensA, tokensB) {
  // A number present on one side and absent from the other is a mismatch
  // whether the other side has a *different* number ("Fox Sports 502" vs
  // "Fox Sports 501", "ITV 1" vs "ITV 2") or no number at all ("Fox
  // Sports 502" vs "Fox Sports News", "ESPN" vs "ESPN 2") — either way,
  // the query was specific about which numbered channel it wants, and
  // generic word overlap ("Fox", "Sports", "ESPN") alone shouldn't paper
  // over that. This now also catches single-digit numbers (not just 2+) —
  // safe to widen now that normalizeForScoring splits a glued channel
  // number like "ITV1" into its own token, which previously kept it out
  // of this check's reach entirely (it was one token, "itv1", matching
  // nothing on either side either way).
  const numsA = tokensA.filter((t) => /^\d+$/.test(t));
  const numsB = tokensB.filter((t) => /^\d+$/.test(t));
  if (!numsA.length && !numsB.length) return false;
  const setA = new Set(numsA);
  const setB = new Set(numsB);
  for (const n of numsA) if (!setB.has(n)) return true;
  for (const n of numsB) if (!setA.has(n)) return true;
  return false;
}

// Generic broadcast-industry words (and bare 1-2 digit numbers) are weak
// evidence on their own — real, unrelated channels collide on exactly
// these constantly: "Lifetime Network" vs "ACC Network" share only
// "network"; a Russian channel literally named "Arig Us" and "1 KBR"
// matched a US ESPN feed and a "Peacock 1" feed purely on the bare
// tokens "us" and "1". Counted at full weight, a single such word was
// enough to clear the match threshold. Counted at reduced weight, actual
// distinctive-word overlap ("fox", "sport", "espn", ...) still works as
// before, but a lone generic/numeric token no longer does the job alone.
const GENERIC_BROADCAST_WORDS = new Set([
  'network', 'channel', 'tv', 'sports', 'sport', 'news', 'live',
  'plus', 'the', 'and', 'of', 'us', 'uk', 'au', 'nz', 'ca', 'ie'
]);

function genericTokenWeight(token) {
  if (GENERIC_BROADCAST_WORDS.has(token)) return 0.25;
  if (/^\d{1,2}$/.test(token)) return 0.25;
  return 1;
}

const COUNTRY_NAME_MAP = {
  'new zealand': 'NZ',
  australia: 'AU',
  'united kingdom': 'GB',
  'great britain': 'GB',
  'united states': 'US',
  canada: 'CA',
  ireland: 'IE',
  'south africa': 'ZA',
  india: 'IN',
  germany: 'DE',
  france: 'FR',
  spain: 'ES',
  italy: 'IT',
  netherlands: 'NL'
};

const COUNTRY_CODE_SET = new Set(['NZ', 'AU', 'GB', 'UK', 'US', 'CA', 'IE', 'ZA', 'IN', 'DE', 'FR', 'ES', 'IT', 'NL']);

function normalizeCountryCode(code) {
  const upper = String(code || '').toUpperCase();
  return upper === 'UK' ? 'GB' : upper;
}

export function extractCountryHint(text) {
  if (!text) return null;
  const raw = String(text);
  const lower = raw.toLowerCase();

  for (const [name, code] of Object.entries(COUNTRY_NAME_MAP)) {
    if (lower.includes(name)) return code;
  }

  const bracket = raw.match(/[([]\s*([A-Za-z]{2,3})\s*[)\]]/);
  if (bracket && COUNTRY_CODE_SET.has(bracket[1].toUpperCase())) {
    return normalizeCountryCode(bracket[1]);
  }

  const prefix = raw.match(/^\s*([A-Za-z]{2,3})\s*[:|-]/);
  if (prefix && COUNTRY_CODE_SET.has(prefix[1].toUpperCase())) {
    return normalizeCountryCode(prefix[1]);
  }

  const tokens = raw.trim().split(/\s+/);
  const last = tokens[tokens.length - 1] || '';
  if (/^[A-Z]{2,3}$/.test(last) && COUNTRY_CODE_SET.has(last)) {
    return normalizeCountryCode(last);
  }

  return null;
}

export function applyCountryAdjustment(score, queryCountry, candidateCountry) {
  if (!queryCountry || !candidateCountry) return score;
  // iptv-org's own data literally uses "UK" as a country value in places
  // (not the ISO "GB" that extractCountryHint normalizes query-side hints
  // to) — compare through the same normalizer on both sides, or a
  // same-country candidate scores as a mismatch against itself.
  const normalizedCandidate = normalizeCountryCode(candidateCountry);
  if (queryCountry === normalizedCandidate) return Math.min(1, score + 0.15);
  return Math.max(0, score - 0.2);
}

const TWENTY_FOUR_SEVEN_PATTERN = '(24\\s*\\/\\s*7|24-7|24x7|\\bnon[\\s-]?stop\\b|\\bnonstop\\b|\\bmarathon\\b|\\ball[\\s-]?day\\b|\\bloop(?:ed)?\\b)';
// Separate RegExp instances for test() vs. replace(): a single /g instance
// reused across calls carries lastIndex between them, which makes test()
// silently alternate true/false on the exact same input.
const TWENTY_FOUR_SEVEN_TEST_RE = new RegExp(TWENTY_FOUR_SEVEN_PATTERN, 'i');
const TWENTY_FOUR_SEVEN_REPLACE_RE = new RegExp(TWENTY_FOUR_SEVEN_PATTERN, 'gi');

export function detectTwentyFourSeven(name, groupTitle) {
  return TWENTY_FOUR_SEVEN_TEST_RE.test(name || '') || TWENTY_FOUR_SEVEN_TEST_RE.test(groupTitle || '');
}

export function cleanTitleForLookup(name) {
  let s = String(name || '');
  s = s.replace(/[([][^)\]]*[)\]]/g, ' ');
  s = s.replace(TWENTY_FOUR_SEVEN_REPLACE_RE, ' ');
  s = s.replace(/\b(FHD|UHD|HD|SD|4K|HEVC|H265|H264)\b/gi, ' ');
  // Season/episode markers ("Season 6", "S07", "S02E05") are decoration
  // on top of the real title, not part of it — left in, they dilute a
  // token-ratio match against the plain show name (e.g. "Peppa Pig
  // Season 6" would otherwise score as only half-matching "Peppa Pig").
  s = s.replace(/\bseason\s*\d+\b/gi, ' ');
  s = s.replace(/\bs\d{1,2}(?:e\d{1,3})?\b/gi, ' ');
  s = s.replace(/\bepisode\s*\d+\b/gi, ' ');
  s = s.replace(/^[A-Za-z]{2,3}\s*[:|-]\s*/, ' ');
  s = s.replace(/[|:_]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ---- logos ------------------------------------------------------------

export function buildLogoMap(logos) {
  const best = new Map();
  const rank = (logo) => {
    let score = 0;
    if (logo.in_use) score += 10;
    if (!logo.feed) score += 5;
    if ((logo.format || '').toUpperCase() === 'PNG') score += 2;
    return score;
  };

  for (const logo of logos) {
    if (!logo.channel || !logo.url) continue;
    const existing = best.get(logo.channel);
    if (!existing || rank(logo) > rank(existing)) {
      best.set(logo.channel, logo);
    }
  }

  const out = {};
  for (const [id, logo] of best.entries()) out[id] = logo.url;
  return out;
}

// iptv-org's public catalog carries alt_names for some rebranded channels
// but not others — e.g. FoxCricket.au already lists "Fox Sports 501" as an
// alt_name, but FoxLeague.au and FoxFooty.au (the same Foxtel numbering
// scheme, channels 502/504) have none at all, so an M3U entry literally
// named "Fox Sports 502" or "Fox Sports 4" had nothing to match against.
// Kayo Sports (a separate streaming platform) carries the identical
// channels under its own branding on top of that. Confirmed against the
// live catalog and Foxtel/Kayo's own published channel numbering.
const KNOWN_ALT_NAMES = {
  'FoxCricket.au': ['Kayo Cricket'],
  'FoxLeague.au': ['Fox Sports 2', 'Fox Sports 502', 'Kayo League'],
  'FoxFooty.au': ['Fox Sports 4', 'Fox Sports 504', 'Kayo Footy'],
  'FoxSportsNews.au': ['Kayo Sports News'],
  'FoxSportsMorePlus.au': ['Fox Sports 507', 'Fox Sports More', 'Kayo Sports More']
};

export function searchIptvApi(query, cleanedQuery, isTwentyFourSeven, channels, guides, logoMap, queryCountry) {
  const byChannelId = new Map();
  for (const guide of guides) {
    if (!guide.channel) continue;
    if (!byChannelId.has(guide.channel)) byChannelId.set(guide.channel, []);
    byChannelId.get(guide.channel).push(guide);
  }

  const matches = [];
  for (const channel of channels) {
    // A candidate whose own name is just "24/7"/"non-stop"/etc (nothing
    // left once cleaned) is never a real content identification — it's
    // exactly the kind of generic stub that would otherwise win on every
    // 24/7-flagged query via substring containment.
    if (isTwentyFourSeven && !cleanTitleForLookup(channel.name)) continue;

    // For a detected 24/7 channel, the raw name still literally contains
    // "24/7" — scoring against it lets any other generic "24/7"-named
    // channel win by containment. Score against the cleaned title only.
    let score = scoreMatch(cleanedQuery, channel.name);
    if (!isTwentyFourSeven) {
      score = Math.max(score, scoreMatch(query, channel.name));
    }
    const allAltNames = [...(channel.alt_names || []), ...(KNOWN_ALT_NAMES[channel.id] || [])];
    for (const alt of allAltNames) {
      score = Math.max(score, scoreMatch(cleanedQuery, alt));
      if (!isTwentyFourSeven) {
        score = Math.max(score, scoreMatch(query, alt));
      }
    }
    score = applyCountryAdjustment(score, queryCountry, channel.country);
    // For 24/7 content identification, a wrong logo is worse than no
    // logo — require a materially more confident match than the general
    // fuzzy-search threshold before treating it as a real identification.
    if (score < (isTwentyFourSeven ? 0.6 : 0.45)) continue;

    const guideList = byChannelId.get(channel.id) || [];
    matches.push({
      sourceType: 'iptv-org-api',
      source: 'iptv-org/api',
      score,
      channelName: channel.name,
      channelId: channel.id,
      logoUrl: (logoMap && logoMap[channel.id]) || null,
      metadata: {
        country: channel.country || null,
        categories: channel.categories || [],
        guides: guideList.slice(0, 6)
      },
      canMergeGuide: false
    });
  }

  return matches;
}
