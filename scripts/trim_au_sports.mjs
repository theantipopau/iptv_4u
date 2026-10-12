// Regenerates guides/au-fox-sports.xml from a fresh epgshare01.online
// download. Usage:
//   curl -o /tmp/au1.xml.gz https://epgshare01.online/epgshare01/epg_ripper_AU1.xml.gz
//   gunzip -k /tmp/au1.xml.gz
//   node scripts/trim_au_sports.mjs /tmp/au1.xml guides/au-fox-sports.xml
import fs from 'fs';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const SRC = process.argv[2];
const OUT = process.argv[3];
const KEEP_IDS = new Set([
  'ESPN.au', 'ESPN2.au',
  'FOX8.au', 'FOX8plus2.au',
  // ponytail: epgshare01 stopped publishing the duplicate ".alt.au" feeds
  // (same display names, different schedules) around 2026-10-11; the plain
  // ids below carry the same channels, so those alt ids were dropped.
  'FoxCricket.au', 'FoxFooty.au', 'FoxLeague.au', 'FoxNews.au',
  'FoxSports503.au', 'FoxSports505.au', 'FoxSports506.au',
  'FoxSportsMore.au', 'FoxSportsNews.au',
  'FoxtelMoviesAction.au', 'FoxtelMoviesActionplus2.au',
  'FoxtelMoviesComedy.au', 'FoxtelMoviesDrama.au',
  'FoxtelMoviesFamily.au', 'FoxtelMoviesFamilyplus2.au',
  'FoxtelMoviesGreats.au', 'FoxtelMoviesHits.au',
  'FoxtelMoviesPremiere.au', 'FoxtelMoviesPremiereplus2.au',
  'FoxtelMoviesRomance.au', 'FoxtelMoviesUltraHD.au',
  'FoxtelOne.au', 'FoxtelOneplus2.au',
  'Racingcom.au', 'SkyRacing1.au', 'SkyRacing2.au',
  'beINSports1.au', 'beINSports2.au', 'beINSports3.au', 'beINSportsXtra.au'
]);

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true, suppressEmptyNode: true });

const xml = fs.readFileSync(SRC, 'utf8');
const parsed = parser.parse(xml);
const tv = parsed.tv;

const arrify = (v) => (v ? (Array.isArray(v) ? v : [v]) : []);

const channels = arrify(tv.channel).filter((c) => KEEP_IDS.has(c['@_id']));
const programmes = arrify(tv.programme).filter((p) => KEEP_IDS.has(p['@_channel']));

console.log('kept channels:', channels.length, 'of', KEEP_IDS.size, 'requested; kept programmes:', programmes.length);
const foundIds = new Set(channels.map(c => c['@_id']));
for (const id of KEEP_IDS) if (!foundIds.has(id)) console.log('MISSING:', id);

const trimmed = {
  '@_generator-info-name': 'epgshare01 AU (trimmed to Fox Sports/Kayo/ESPN/beIN/Racing)',
  channel: channels,
  programme: programmes
};

const out = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ tv: trimmed })}`;
fs.writeFileSync(OUT, out);
console.log('wrote', OUT, (fs.statSync(OUT).size / 1024 / 1024).toFixed(2), 'MB');
