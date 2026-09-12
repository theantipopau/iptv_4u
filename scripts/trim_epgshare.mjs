// Generalized version of trim_au_sports.mjs — filters a downloaded
// epgshare01.online guide down to channels whose id matches any of a set
// of regexes, instead of an exhaustive hand-picked id list. Used whenever
// a country's full file is too large for a Cloudflare Worker to fetch in
// one request (~15MB decompressed cap — see shared/fetch-utils.js).
//
// Usage:
//   curl -o /tmp/xx.xml.gz https://epgshare01.online/epgshare01/epg_ripper_<CC><n>.xml.gz
//   gunzip -k /tmp/xx.xml.gz
//   node scripts/trim_epgshare.mjs /tmp/xx.xml guides/out.xml "<generator name>" <pattern1> [pattern2 ...]
//
// Each pattern is a case-insensitive regex tested against the channel id
// (e.g. "^ESPN" or "^Fox\\.(News|Sports)").
import fs from 'fs';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const [, , SRC, OUT, GENERATOR_NAME, ...patternStrings] = process.argv;
if (!SRC || !OUT || !GENERATOR_NAME || !patternStrings.length) {
  console.error('Usage: node trim_epgshare.mjs <src.xml> <out.xml> "<generator name>" <pattern1> [pattern2 ...]');
  process.exit(1);
}

const patterns = patternStrings.map((p) => new RegExp(p, 'i'));
const matchesAny = (id) => patterns.some((re) => re.test(id));

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true, suppressEmptyNode: true });

const xml = fs.readFileSync(SRC, 'utf8');
const parsed = parser.parse(xml);
const tv = parsed.tv;

const arrify = (v) => (v ? (Array.isArray(v) ? v : [v]) : []);

const channels = arrify(tv.channel).filter((c) => matchesAny(c['@_id'] || ''));
const keepIds = new Set(channels.map((c) => c['@_id']));
const programmes = arrify(tv.programme).filter((p) => keepIds.has(p['@_channel']));

console.log('kept channels:', channels.length);
console.log('kept programmes:', programmes.length);
console.log(channels.map((c) => c['@_id']).sort().join('\n'));

const trimmed = {
  '@_generator-info-name': GENERATOR_NAME,
  channel: channels,
  programme: programmes
};

const out = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ tv: trimmed })}`;
fs.writeFileSync(OUT, out);
console.log('wrote', OUT, (fs.statSync(OUT).size / 1024 / 1024).toFixed(2), 'MB');
