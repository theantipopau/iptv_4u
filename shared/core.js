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

/**
 * Remove characters XML 1.0 forbids outright (everything below 0x20 except
 * tab/newline/carriage-return). A raw control character anywhere in a
 * provider-supplied name or title makes the whole document unparseable for a
 * strict player, which fails exactly like a missing guide.
 * @param {string} text
 * @returns {string}
 */
export function stripInvalidXmlChars(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

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
  // Strip characters XML 1.0 forbids outright before serialising: a single
  // raw control character in a provider-supplied channel name or programme
  // title makes the whole document unparseable for a strict player, which
  // fails exactly like a missing guide. See shared/validate.js.
  const body = stripInvalidXmlChars(builder.build({ tv }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
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

// Write endpoints are gated by one shared secret (ADMIN_TOKEN) sent as the
// X-Admin-Token header. Callers skip this entirely while no token is configured,
// so the app keeps working until the secret is set (see README).
export function assertAdmin(given, expected) {
  if (!expected) return;
  let diff = typeof given === 'string' && given.length === expected.length ? 0 : 1;
  for (let i = 0; diff === 0 && i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff === 0) return;
  const error = new Error(given ? 'The admin token is wrong.' : 'This action needs the admin token.');
  error.status = 401;
  error.code = given ? 'ADMIN_TOKEN_INVALID' : 'ADMIN_TOKEN_REQUIRED';
  throw error;
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

// Country of a custom-guide channel, for applyCountryAdjustment: from an id
// suffix ("ESPN.au", "CNN.HD.us2"), else from a country-prefixed guide file
// name (guides/nz-sky-sport.xml has bare numeric ids).
export function guideChannelCountry(channelId, guideUrl) {
  const fromId = /\.([a-z]{2})\d?$/i.exec(channelId || '');
  if (fromId) return fromId[1];
  const fromUrl = /\/(au|uk|us|nz|za)-[^/]*$/i.exec(guideUrl || '');
  return fromUrl ? fromUrl[1] : null;
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

// Splits a 24/7 channel name into the show and an optional " Season N" tail,
// and finds its curated entry (if any). Shared by the title/description
// helpers below and by the publish step, which prefers curated text over a
// TMDB guess (TMDB happily answers "Harry Poter" with "Wizards of Baking").
function splitTwentyFourSeven(name) {
  let s = String(name || '');
  s = s.replace(/[([][^)\]]*[)\]]/g, ' ');
  s = s.replace(TWENTY_FOUR_SEVEN_REPLACE_RE, ' ');
  s = s.replace(/\b(FHD|UHD|HD|SD|4K|HEVC|H265|H264|VIP)\b/gi, ' ');
  // The provider also lists these as "<Film> Movie Collection".
  s = s.replace(/\bmovie\s+collection\b/gi, ' ');
  s = s.replace(/^[A-Za-z]{2,3}\s*[:|-]\s*/, ' ');
  s = s.replace(/[|_]/g, ' ');
  s = s.replace(/\bS0*(\d{1,2})\b/gi, 'Season $1');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return { show: '', season: '', fixed: null };
  const seasonMatch = s.match(/^(.*?)( Season \d+)$/);
  const show = seasonMatch ? seasonMatch[1] : s;
  return { show, season: seasonMatch ? seasonMatch[2] : '', fixed: TWENTY_FOUR_SEVEN_FIXES[titleKey(show)] || null };
}

/**
 * A readable programme title for a 24/7 channel: "24/7 Seinfeld S07 [VIP]"
 * becomes "Seinfeld Season 7". Unlike cleanTitleForLookup, season markers are
 * kept — they're useful to a viewer, just not to a search.
 */
export function twentyFourSevenTitle(name) {
  const { show, season, fixed } = splitTwentyFourSeven(name);
  if (!show) return String(name || '').trim();
  return `${fixed ? fixed.title : titleCaseShouting(show)}${season}`;
}

/** The curated {title, description, logo} for a 24/7 channel, when one is known. */
export function twentyFourSevenCurated(name) {
  return splitTwentyFourSeven(name).fixed;
}

/** A curated description for a 24/7 channel, when one is known. */
export function twentyFourSevenDescription(name) {
  return twentyFourSevenCurated(name)?.description || null;
}

const titleKey = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');

// Provider channel names carry typos and odd spacing; these are the readable
// titles and descriptions (what's actually playing) for the channels in the
// published lineup. Keyed by the cleaned name with everything but letters and
// digits removed — each entry lists the spellings it answers to. Add a `logo`
// to pin a hand-picked image (applied at publish unless the channel was fixed
// manually in the app). Not exhaustive: unknown channels fall back to a
// generic line.
const TWENTY_FOUR_SEVEN_CURATED = [
  { names: ['Harry Poter', 'Harry Potter'], title: 'Harry Potter', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6e/Harry_Potter_wordmark.svg/330px-Harry_Potter_wordmark.svg.png', description: 'Harry Potter, non-stop: all eight films play back to back, from Harry Potter and the Philosopher’s Stone to Harry Potter and the Deathly Hallows – Part 2. Follow Harry, Ron and Hermione through their years at Hogwarts.' },
  { names: ['Iron Man'], title: 'Iron Man', logo: 'https://logos-world.net/wp-content/uploads/2020/12/Iron-Man-Logo-2008.png', description: 'Tony Stark builds the armour and takes on the world, with the Iron Man films on repeat from the 2008 original through Iron Man 2 and Iron Man 3.' },
  { names: ['Star Trek'], title: 'Star Trek', logo: 'https://i.imgur.com/8cvXYiT.png', description: 'The crew of the starship Enterprise boldly go where no one has gone before, with Star Trek playing around the clock. Exploration, diplomacy and the occasional space battle.' },
  { names: ['Seinfeld'], title: 'Seinfeld', description: 'Classic Seinfeld episodes, back to back. Jerry, George, Elaine and Kramer find comedy in the smallest details of New York life.' },
  { names: ['Planet Earth II'], title: 'Planet Earth II', logo: 'https://i.imgur.com/mzL9YOP.png', description: 'David Attenborough explores the world’s islands, mountains, jungles, deserts, grasslands and cities in this landmark nature series. Spectacular footage plays on a continuous loop.' },
  { names: ['Planet Earth III'], title: 'Planet Earth III', logo: 'https://i.imgur.com/mzL9YOP.png', description: 'David Attenborough returns with a new look at life on Earth, from coasts and oceans to jungles and freshwater. Stunning wildlife footage plays on a continuous loop.' },
  { names: ['Bobs Burgers'], title: 'Bob’s Burgers', description: 'Bob Belcher and his family run a struggling burger restaurant and always find a way to keep the grill on. Bob’s Burgers episodes play non-stop.' },
  { names: ['Guardians of the Galaxy'], title: 'Guardians of the Galaxy', logo: 'https://upload.wikimedia.org/wikipedia/commons/e/e2/Guardians_of_the_Galaxy-Logo.png?utm_source=commons.wikimedia.org&utm_campaign=index&utm_content=original', description: 'Peter Quill and his ragtag team of cosmic misfits save the galaxy on repeat. The Guardians of the Galaxy films, from Vol. 1 to Vol. 3, play back to back.' },
  { names: ['John Wick'], title: 'John Wick', logo: 'https://www.nicepng.com/png/detail/106-1060357_john-wick-image-john-wick-movie-png.png', description: 'A legendary hitman is dragged back into the underworld he left behind. The John Wick films play back to back.' },
  { names: ['The Simpsons'], title: 'The Simpsons', description: 'Homer, Marge, Bart, Lisa and Maggie cause chaos in Springfield. The Simpsons play non-stop, one season on a loop.' },
  { names: ['Cosmos A Spacetime Odyssey'], title: 'Cosmos: A Spacetime Odyssey', logo: 'https://play-lh.googleusercontent.com/VSCDrcHOSRLdsIWXX3al31W_dzexLRK8NiFnCazEMZOgLkKOYuUKMwxNkYFR62ykTqI', description: 'Neil deGrasse Tyson hosts a journey through space and time, from the Big Bang to the far future. The 2014 series plays on a continuous loop.' },
  { names: ['The Hobbit And Lord Of TheRings', 'The Hobbit and Lord of the Rings'], title: 'The Lord of the Rings & The Hobbit', logo: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTCGgkHg567OSfQSca0q1jzuCyTZq6dYatCZX4zM8_11xRDh9EGbjhQqG_5&s=10', description: 'The Lord of the Rings and The Hobbit films on repeat, around the clock.' },
  { names: ['Pirates Of The Caribbean'], title: 'Pirates of the Caribbean', description: 'Captain Jack Sparrow sets sail on repeat. The Pirates of the Caribbean films play back to back, from The Curse of the Black Pearl to Dead Men Tell No Tales.' },
  { names: ['Despicable Me'], title: 'Despicable Me', logo: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d6/Despicable_Me_logo_2.svg/1280px-Despicable_Me_logo_2.svg.png?utm_source=en.wikipedia.org&utm_campaign=index&utm_content=thumbnail', description: 'Gru, his adopted girls and a legion of Minions cause mischief on repeat. The Despicable Me films play back to back.' },
  { names: ['Oceans Eleven', 'Ocean’s Eleven'], title: 'Ocean’s Eleven', logo: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ee/Oceanseleven-logo.svg/1280px-Oceanseleven-logo.svg.png?utm_source=commons.wikimedia.org&utm_campaign=index&utm_content=thumbnail', description: 'Danny Ocean and his crew plan the ultimate casino heists. The Ocean’s films play back to back.' },
  { names: ['Band of Brothers'], title: 'Band of Brothers', logo: 'https://pixel.disco.nowtv.com/uuid/74bdea81-648d-3d35-8a92-38881ffeabe7/LOGO_TITLE_WIDE?language=en-GB&proposition=NOWOTT&version=957cfa0b-5ec4-3d80-9fa6-66e9c85bad2c', description: 'The acclaimed miniseries follows Easy Company of the US 101st Airborne through World War II, from training to the end of the war. Episodes play on a continuous loop.' },
  { names: ['Transformers'], title: 'Transformers', logo: 'https://logos-world.net/wp-content/uploads/2021/11/Transformers-Logo-2014-present.png', description: 'Autobots and Decepticons battle for the fate of Earth. The Transformers films play back to back.' },
  { names: ['Mission Impossible'], title: 'Mission: Impossible', logo: 'https://static.wikia.nocookie.net/logopedia/images/7/75/Img_0940.png/revision/latest?cb=20160718234043', description: 'Ethan Hunt and the IMF take on impossible missions around the globe. The Mission: Impossible films play non-stop.' },
  { names: ['Home Alone'], title: 'Home Alone', logo: 'https://cdn.prod.website-files.com/61e1db1c178256e11be974b0/63946895bada47049d45a3ea_zQMNXH4rg8MFovQCr-qMQQwx9shwNo32EHB_custom_logo.webp', description: 'Kevin McCallister defends the house against two bumbling burglars. The Home Alone films play on repeat.' },
  { names: ['Game of Thrones'], title: 'Game of Thrones', description: 'Great houses fight for the Iron Throne across Westeros. Game of Thrones plays on a continuous loop, one season at a time.' },
  { names: ['Thor'], title: 'Thor', logo: 'https://1000logos.net/wp-content/uploads/2023/06/Thor-Logo-2011.png', description: 'The God of Thunder wields Mjolnir to protect Asgard and Earth. The Thor films play back to back.' },
  { names: ['The Bourne'], title: 'The Bourne Films', logo: 'https://upload.wikimedia.org/wikipedia/commons/a/a5/Bourne_logo.png?utm_source=commons.wikimedia.org&utm_campaign=index&utm_content=original', description: 'Jason Bourne, an amnesiac agent, hunts for his true identity while the CIA hunts him. The Bourne films play back to back.' },
  { names: ['How To Train Your Dragon'], title: 'How to Train Your Dragon', description: 'Hiccup and his dragon Toothless change the world of Vikings and dragons. The How to Train Your Dragon films play on repeat.' },
  { names: ['Toy Story'], title: 'Toy Story', logo: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0a/Toy_Story_logo.svg/330px-Toy_Story_logo.svg.png', description: 'Woody, Buzz Lightyear and the toys come alive when no one is watching. The Toy Story films play back to back.' },
  { names: ['Men in Black'], title: 'Men in Black', logo: 'https://upload.wikimedia.org/wikipedia/commons/8/83/Men_In_Black_%28film_franchise%29_logo.svg?utm_source=en.wikipedia.org&utm_campaign=index&utm_content=original', description: 'Agents J and K police the aliens living among us. The Men in Black films play non-stop.' },
  { names: ['Ace Ventura'], title: 'Ace Ventura', description: 'Jim Carrey is the wildly unconventional pet detective. The Ace Ventura films play on repeat.' },
  { names: ['Futurama'], title: 'Futurama', description: 'Fry, Leela and Bender deliver packages across the universe in the 31st century. Futurama episodes play non-stop, one season on a loop.' },
  { names: ['Its Always Sunny in Philadelphia'], title: 'It’s Always Sunny in Philadelphia', description: 'The gang at Paddy’s Pub scheme and squabble their way through Philadelphia. It’s Always Sunny plays non-stop, one season on a loop.' },
  { names: ['300'], title: '300', logo: 'https://upload.wikimedia.org/wikipedia/fr/2/27/300_%28film%29_Logo.png?utm_source=fr.wikipedia.org&utm_campaign=index&utm_content=original', description: 'King Leonidas and his Spartans make a last stand against the Persian army. 300 and its follow-up play back to back.' },
  { names: ['The Hangover'], title: 'The Hangover', description: 'Three friends wake up after a Las Vegas bachelor party with no memory of the night before. The Hangover films play back to back.' },
  { names: ['Spider Man', 'Spider-Man'], title: 'Spider-Man', logo: 'https://upload.wikimedia.org/wikipedia/commons/1/12/Spider-Man_video_game_series_logo.png', description: 'Peter Parker swings through New York as your friendly neighbourhood hero. Spider-Man films play on repeat.' },
  { names: ['Wreck It Ralph'], title: 'Wreck-It Ralph', logo: 'https://upload.wikimedia.org/wikipedia/en/6/6c/Wreck-It_Ralph_logo.svg?utm_source=en.wikipedia.org&utm_campaign=index&utm_content=original', description: 'An arcade villain sets out to prove he can be a hero. Wreck-It Ralph and Ralph Breaks the Internet play back to back.' },
  { names: ['Tron'], title: 'Tron', logo: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ee/Tron_franchise_logo.svg/330px-Tron_franchise_logo.svg.png?utm_source=en.wikipedia.org&utm_campaign=parser&utm_content=thumbnail', description: 'Inside a digital world, programs fight for survival on the Grid. Tron and Tron: Legacy play back to back.' },
  { names: ['Austin Powers'], title: 'Austin Powers', logo: 'https://d1yjjnpx0p53s8.cloudfront.net/styles/logo-thumbnail/s3/0015/4049/brand.gif?itok=s8rWnnZO', description: 'Mike Myers is the groovy British spy out to stop Dr. Evil. The Austin Powers films play non-stop.' },
  { names: ['The Mandalorian'], title: 'The Mandalorian', description: 'A lone bounty hunter guards the Child across the Star Wars galaxy. The Mandalorian plays on a continuous loop, one season at a time.' },
  { names: ['The Blue Planet 2001', 'The Blue Planet'], title: 'The Blue Planet', description: 'David Attenborough explores the world’s oceans, from sunlit shallows to the deepest trenches. The landmark nature series plays on a continuous loop.' },
  { names: ['Aladdin'], title: 'Aladdin', description: 'A street kid, a magic lamp and a wisecracking Genie. Aladdin plays on repeat.' },
  { names: ['Peppa Pig'], title: 'Peppa Pig', logo: 'https://images.pluto.tv/channels/5d14fb6c84dd37df3b4290c5/colorLogoPNG_1730733871298.png', description: 'Peppa, George and their family jump in muddy puddles and enjoy everyday adventures. Peppa Pig episodes play non-stop.' },
  { names: ['DISNEY Movies'], title: 'Disney Movies', logo: 'https://images.seeklogo.com/logo-png/4/2/disney-logo-png_seeklogo-41972.png', description: 'A non-stop run of Disney films, from Aladdin and The Lion King to Frozen and Moana. Classic and modern animated favourites for the whole family.' },
  { names: ['BLUEY'], title: 'Bluey', logo: 'https://upload.wikimedia.org/wikipedia/commons/a/ad/TV_logo_for_Bluey.png', description: 'Bluey and her family turn everyday life into imaginative play. Bluey episodes play non-stop.' },
  { names: ['Avengers'], title: 'Avengers', logo: 'https://logos-world.net/wp-content/uploads/2020/05/The-Avengers-Logo-2012.jpg', description: 'Earth’s mightiest heroes assemble to save the world. The Avengers films play back to back.' },
  { names: ['LAW & ORDER'], title: 'Law & Order', description: 'Detectives investigate and prosecutors try the crimes in New York. Law & Order episodes play non-stop.' },
  { names: ['WILL FERRELL MOVIES'], title: 'Will Ferrell Movies', description: 'Will Ferrell’s comedies play back to back, from Elf and Anchorman to Step Brothers and Talladega Nights.' },
  { names: ['WAR MOVIES'], title: 'War Movies', description: 'War films play non-stop, from World War II epics to modern combat dramas.' },
  { names: ['BREAKING BAD'], title: 'Breaking Bad', description: 'A chemistry teacher turns to making methamphetamine after a cancer diagnosis, and the consequences spiral. Breaking Bad plays on a continuous loop.' },
  { names: ['Peacock Live Dateline', 'Dateline'], title: 'Dateline', description: 'True-crime investigations and mysteries from NBC’s Dateline, playing around the clock.' },
  { names: ['ROBIN WILLIAMS'], title: 'Robin Williams', description: 'Films starring Robin Williams play back to back, from Mrs. Doubtfire and Jumanji to Good Will Hunting.' }
];

const TWENTY_FOUR_SEVEN_FIXES = Object.fromEntries(
  TWENTY_FOUR_SEVEN_CURATED.flatMap((entry) => entry.names.map((name) => [titleKey(name), entry]))
);

// Live channels that no free guide covers (checked: epgshare01's full set and
// the provider's own guide). Rather than show "no information" they get a
// repeating placeholder programme; the note says plainly it isn't a schedule.
const PLACEHOLDER_NOTE = 'No programme schedule is published for this channel, so this guide entry is a placeholder.';
const PLACEHOLDER_CHANNELS = [
  [/sky news australia/i, 'Sky News Australia', 'Live Australian and international news, 24 hours a day.'],
  [/fox sports 508/i, 'Fox Sports 508', 'A Fox Sports live-sport channel showing whichever event is on air.'],
  [/ufc ppv/i, 'UFC Pay-Per-View', 'Live UFC pay-per-view coverage, from the early prelims to the main card, when an event is on.'],
  [/sky sports f1/i, 'Sky Sports F1', 'Live Formula 1 coverage: practice, qualifying and races, plus analysis and documentaries.'],
  [/sky sports main event/i, 'Sky Sports Main Event', 'Live top fixtures and big sporting events, with build-up and analysis.'],
  [/clubland/i, 'Clubland TV', 'Dance and club music videos, non-stop.'],
  [/trace hits/i, 'Trace Hits', 'The latest chart hits in music videos, non-stop.'],
  [/pop \+1/i, 'Pop +1', 'Kids’ entertainment, shown an hour after the main Pop channel.'],
  [/hallmark movies/i, 'Hallmark Movies & Mysteries', 'Cosy mystery films and series, around the clock.'],
  [/super ?sport rugby/i, 'SuperSport Rugby', 'Live rugby from around the world, plus replays and analysis.'],
  [/sky sport 8/i, 'Sky Sport 8 Premier League', 'Live English Premier League football, with build-up and highlights.'],
  [/peacock/i, 'Peacock', 'A live Peacock channel, streaming around the clock.']
];

/** A repeating placeholder {title, description} for a live channel that has no schedule anywhere. */
export function placeholderProgramme(name) {
  const known = PLACEHOLDER_CHANNELS.find(([pattern]) => pattern.test(name || ''));
  if (known) return { title: known[1], description: `${known[2]} ${PLACEHOLDER_NOTE}` };
  const title = String(name || '').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/^[A-Za-z]{2,5}\s*[:|-]\s*/, '').replace(/\s+/g, ' ').trim() || String(name || '').trim();
  return { title, description: `${title} is a live channel. ${PLACEHOLDER_NOTE}` };
}

const ROMAN_NUMERAL = /^(?=[IVXLC]+$)C{0,3}(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

// "LAW & ORDER" -> "Law & Order"; roman numerals ("Planet Earth II") and
// numbers are left alone.
function titleCaseShouting(text) {
  return text.split(' ').map((word) => {
    if (word.length < 2 || word !== word.toUpperCase() || !/[A-Z]/.test(word) || ROMAN_NUMERAL.test(word)) return word;
    return word.charAt(0) + word.slice(1).toLowerCase();
  }).join(' ');
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

// ---- curated channel alias registry ----------------------------------------
//
// Structured replacement for the old flat KNOWN_ALT_NAMES map — same
// purpose (bridge a channel's real-world alternate names/ids to iptv-org's
// single canonical entry), but shaped so each fact (country, channel
// number, provider-specific id, platform branding) is its own field
// instead of being smushed into one alias-string list. `channelNumber` is
// reference/display metadata ONLY — it is never folded into the matched-
// name corpus, so a channel number alone can never cause a match (many
// providers reuse the same number for an unrelated channel).
//
// Seeded with every mapping verified during this project's real-playlist
// debugging sessions: AU Fox Sports/Kayo, NZ Sky Sport, ZA SuperSport.
// Not exhaustive by design — treat as a versioned, extensible source, not
// a permanent ground truth; add more entries the same way if a real
// playlist turns up another gap.
export const CHANNEL_ALIAS_REGISTRY = [
  // --- Australia: Fox Sports / Kayo ---
  { id: 'FoxSportsNews.au', country: 'AU', canonicalName: 'Fox Sports News', channelNumber: '500', aliases: [], platformNames: { kayo: 'Kayo Sports News' }, providerEpgIds: [] },
  { id: 'FoxCricket.au', country: 'AU', canonicalName: 'Fox Cricket', channelNumber: '501', aliases: ['Fox Sports 1', 'Fox Sports 501', 'FS1'], platformNames: { kayo: 'Kayo Cricket' }, providerEpgIds: [] },
  { id: 'FoxLeague.au', country: 'AU', canonicalName: 'Fox League', channelNumber: '502', aliases: ['Fox Sports 2', 'Fox Sports 502', 'FS2'], platformNames: { kayo: 'Kayo League' }, providerEpgIds: [] },
  { id: 'FoxSports503.au', country: 'AU', canonicalName: 'Fox Sports 503', channelNumber: '503', aliases: ['Fox Sports 3', 'FS3'], platformNames: {}, providerEpgIds: [] },
  { id: 'FoxFooty.au', country: 'AU', canonicalName: 'Fox Footy', channelNumber: '504', aliases: ['Fox Sports 4', 'Fox Sports 504', 'FS4'], platformNames: { kayo: 'Kayo Footy' }, providerEpgIds: [] },
  { id: 'FoxSports505.au', country: 'AU', canonicalName: 'Fox Sports 505', channelNumber: '505', aliases: ['Fox Sports 5', 'FS5'], platformNames: {}, providerEpgIds: [] },
  { id: 'FoxSports506.au', country: 'AU', canonicalName: 'Fox Sports 506', channelNumber: '506', aliases: ['Fox Sports 6', 'FS6'], platformNames: {}, providerEpgIds: [] },
  {
    id: 'FoxSportsMorePlus.au',
    country: 'AU',
    canonicalName: 'Fox Sports More+',
    channelNumber: '507',
    aliases: ['Fox Sports 507', 'Fox Sports More'],
    platformNames: { kayo: 'Kayo Sports More' },
    // Legacy ids seen in the wild for this exact channel across different
    // EPG sources — see guides/README.md's "Channel 507 EPG compatibility
    // note" for how these were confirmed.
    providerEpgIds: ['FoxSportsMore.au', 'FoxSports507.au']
  },

  // --- New Zealand: Sky Sport (+ ESPN/ESPN2, bundled alongside it on Sky Go/Sky Sport Now) ---
  { id: 'SkySportSelect.nz', country: 'NZ', canonicalName: 'Sky Sport Select', channelNumber: '050', aliases: [], platformNames: {}, providerEpgIds: [] },
  { id: 'SkySport1.nz', country: 'NZ', canonicalName: 'Sky Sport 1', channelNumber: '051', aliases: [], platformNames: {}, providerEpgIds: [] },
  { id: 'SkySport2.nz', country: 'NZ', canonicalName: 'Sky Sport 2', channelNumber: '052', aliases: [], platformNames: {}, providerEpgIds: [] },
  { id: 'SkySport3.nz', country: 'NZ', canonicalName: 'Sky Sport 3', channelNumber: '053', aliases: [], platformNames: {}, providerEpgIds: [] },
  { id: 'SkySport4.nz', country: 'NZ', canonicalName: 'Sky Sport 4', channelNumber: '054', aliases: [], platformNames: {}, providerEpgIds: [] },
  { id: 'SkySport5.nz', country: 'NZ', canonicalName: 'Sky Sport 5', channelNumber: '055', aliases: [], platformNames: {}, providerEpgIds: [] },
  { id: 'SkySport6.nz', country: 'NZ', canonicalName: 'Sky Sport 6', channelNumber: '056', aliases: [], platformNames: {}, providerEpgIds: [] },
  { id: 'SkySport7.nz', country: 'NZ', canonicalName: 'Sky Sport 7', channelNumber: '057', aliases: [], platformNames: {}, providerEpgIds: [] },
  { id: 'SkySportPremierLeague.nz', country: 'NZ', canonicalName: 'Sky Sport Premier League', channelNumber: '058', aliases: [], platformNames: {}, providerEpgIds: [] },
  { id: 'SkySport9.nz', country: 'NZ', canonicalName: 'Sky Sport 9', channelNumber: '059', aliases: [], platformNames: {}, providerEpgIds: [] },
  // Not in iptv-org's public catalog at all (confirmed) — kept here anyway
  // so matchAliasRegistry can still identify/name them; real schedule for
  // both only ever comes from the guides/nz-sky-sport.xml custom guide
  // (channel ids "60"/"61" there), never from this registry.
  { id: 'ESPN.nz', country: 'NZ', canonicalName: 'ESPN', channelNumber: '060', aliases: [], platformNames: {}, providerEpgIds: [] },
  { id: 'ESPN2.nz', country: 'NZ', canonicalName: 'ESPN2', channelNumber: '061', aliases: [], platformNames: {}, providerEpgIds: [] },

  // --- South Africa: SuperSport (DStv) ---
  { id: 'SuperSportBlitz.za', country: 'ZA', canonicalName: 'SuperSport Blitz', channelNumber: '200', aliases: [], platformNames: { dstv: 'SuperSport Blitz' }, providerEpgIds: [] },
  { id: 'SuperSportGrandstand.za', country: 'ZA', canonicalName: 'SuperSport Grandstand', channelNumber: '201', aliases: [], platformNames: { dstv: 'SuperSport Grandstand' }, providerEpgIds: ['GRANDSTAND.za'] },
  { id: 'SuperSportPSL.za', country: 'ZA', canonicalName: 'SuperSport PSL', channelNumber: '202', aliases: [], platformNames: { dstv: 'SuperSport PSL' }, providerEpgIds: ['PSL.za'] },
  { id: 'SuperSportPremierLeague.za', country: 'ZA', canonicalName: 'SuperSport Premier League', channelNumber: '203', aliases: [], platformNames: { dstv: 'SuperSport Premier League' }, providerEpgIds: [] },
  { id: 'SuperSportLaLiga.za', country: 'ZA', canonicalName: 'SuperSport LaLiga', channelNumber: '204', aliases: [], platformNames: { dstv: 'SuperSport LaLiga' }, providerEpgIds: [] },
  { id: 'SuperSportFootball.za', country: 'ZA', canonicalName: 'SuperSport Football', channelNumber: '205', aliases: [], platformNames: { dstv: 'SuperSport Football' }, providerEpgIds: ['FOOTBALL.za'] },
  { id: 'SuperSportFootballPlus.za', country: 'ZA', canonicalName: 'SuperSport Football Plus', channelNumber: '206', aliases: ['SuperSport Variety 1'], platformNames: { dstv: 'SuperSport Football Plus' }, providerEpgIds: ['SuperSportVariety1.za'] },
  { id: 'SuperSportVariety2.za', country: 'ZA', canonicalName: 'SuperSport Variety 2', channelNumber: '207', aliases: [], platformNames: { dstv: 'SuperSport Variety 2' }, providerEpgIds: [] },
  { id: 'SuperSportVariety3.za', country: 'ZA', canonicalName: 'SuperSport Variety 3', channelNumber: '208', aliases: [], platformNames: { dstv: 'SuperSport Variety 3' }, providerEpgIds: [] },
  { id: 'SuperSportVariety4.za', country: 'ZA', canonicalName: 'SuperSport Variety 4', channelNumber: '209', aliases: [], platformNames: { dstv: 'SuperSport Variety 4' }, providerEpgIds: [] },
  { id: 'SuperSportAction.za', country: 'ZA', canonicalName: 'SuperSport Action', channelNumber: '210', aliases: [], platformNames: { dstv: 'SuperSport Action' }, providerEpgIds: ['ACTION.za'] },
  { id: 'SuperSportRugby.za', country: 'ZA', canonicalName: 'SuperSport Rugby', channelNumber: '211', aliases: [], platformNames: { dstv: 'SuperSport Rugby' }, providerEpgIds: ['RUGBY.za'] },
  { id: 'SuperSportCricket.za', country: 'ZA', canonicalName: 'SuperSport Cricket', channelNumber: '212', aliases: [], platformNames: { dstv: 'SuperSport Cricket' }, providerEpgIds: ['CRICKET.za'] },
  { id: 'SuperSportGolf.za', country: 'ZA', canonicalName: 'SuperSport Golf', channelNumber: '213', aliases: [], platformNames: { dstv: 'SuperSport Golf' }, providerEpgIds: ['GOLF.za'] },
  { id: 'SuperSportTennis.za', country: 'ZA', canonicalName: 'SuperSport Tennis', channelNumber: '214', aliases: [], platformNames: { dstv: 'SuperSport Tennis' }, providerEpgIds: ['TENNIS.za'] },
  { id: 'SuperSportMotorsport.za', country: 'ZA', canonicalName: 'SuperSport Motorsport', channelNumber: '215', aliases: [], platformNames: { dstv: 'SuperSport Motorsport' }, providerEpgIds: ['MOTORSPORT.za'] },
  { id: 'WWEChannelAfrica.za', country: 'ZA', canonicalName: 'WWE Channel Africa', channelNumber: '236', aliases: ['WWE Channel'], platformNames: { dstv: 'SuperSport WWE' }, providerEpgIds: ['WWE.CHANNEL.za'] }
];

const ALIAS_REGISTRY_BY_ID = new Map(CHANNEL_ALIAS_REGISTRY.map((entry) => [entry.id, entry]));

// Every display-name-shaped alias for a registry entry — aliases plus
// platform names, deliberately excluding channelNumber and providerEpgIds
// (those are ids, not names; matching on a bare number is exactly what
// "do not match on channel number alone" rules out).
function registryDisplayAliases(entry) {
  return [...entry.aliases, ...Object.values(entry.platformNames)];
}

// Folded into an iptv-org catalog channel's own alt_names when scoring it
// (searchIptvApi below) — this is what makes e.g. "Fox Sports 502" or
// "Kayo League" match the catalog's "Fox League" entry (which upstream
// carries no alt_names of its own for this), while keeping that entry's
// real logo/metadata as the winning candidate rather than a duplicate.
export function getRegistryAliasNames(channelId) {
  const entry = ALIAS_REGISTRY_BY_ID.get(channelId);
  return entry ? registryDisplayAliases(entry) : [];
}

// A standalone match source for registry entries that identify a channel
// iptv-org's own catalog doesn't carry at all (e.g. ESPN.nz/ESPN2.nz —
// confirmed absent from the live catalog) — without this, those channels
// could never be identified via the public-catalog path no matter how
// the query is phrased, since there'd be no catalog channel to attach an
// alt_name to in the first place. Always canMergeGuide:false — a real
// schedule, when one exists, only ever comes from a worker/custom-guide
// source, never from this identity-only registry.
export function matchAliasRegistry(query, cleanedQuery, isTwentyFourSeven, queryCountry) {
  const matches = [];
  for (const entry of CHANNEL_ALIAS_REGISTRY) {
    const names = [entry.canonicalName, ...registryDisplayAliases(entry)];
    let score = 0;
    for (const name of names) {
      score = Math.max(score, scoreMatch(cleanedQuery, name));
      if (!isTwentyFourSeven) score = Math.max(score, scoreMatch(query, name));
    }
    score = applyCountryAdjustment(score, queryCountry, entry.country);
    if (score < (isTwentyFourSeven ? 0.6 : 0.45)) continue;

    matches.push({
      sourceType: 'alias-registry',
      source: 'channel alias registry',
      score,
      channelName: entry.canonicalName,
      channelId: entry.id,
      logoUrl: null,
      metadata: { country: entry.country, channelNumber: entry.channelNumber },
      canMergeGuide: false
    });
  }
  return matches;
}

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
    const allAltNames = [...(channel.alt_names || []), ...getRegistryAliasNames(channel.id)];
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
