// Builds guides/stan-sport.xml from TheSportsDB's public "Stan Sport AU" TV
// schedule page (the free API key only returns one event, so the page is the
// only free source). Usage:
//   node scripts/stan_events.mjs guides/stan-sport.xml
//
// The page lists matches but not which of the provider's interchangeable
// "Stan Sport AU Event N" slots carries each one, so events are dealt out to
// slots in start order and every programme's description lists everything on
// Stan Sport at that time. ponytail: no end times on the page, so every match
// is assumed to run 2h; add a per-sport length if non-soccer events show up.
import fs from 'fs';

const OUT = process.argv[2];
const SLOTS = 35; // the provider's "Stan Sport AU Event 1..35"
const DURATION_MS = 2 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const res = await fetch('https://www.thesportsdb.com/channel/6786-stan-sport-au-tv-schedule', {
  headers: { 'User-Agent': 'iptv-4u guide builder (github.com/theantipopau/iptv_4u)' }
});
if (!res.ok) throw new Error(`schedule page returned ${res.status}`);
const html = await res.text();
const start = html.indexOf('Next 7 Days');
if (start < 0) throw new Error('schedule page layout changed: no "Next 7 Days" heading');
const section = html.slice(start, html.indexOf('Recent past events', start) > 0 ? html.indexOf('Recent past events', start) : undefined);

// Walk day headings ("Sun 18 Oct (today)") and event rows ("Team v Team</a> (13:00 UTC)").
const year = new Date().getUTCFullYear();
const events = [];
let day = null;
for (const m of section.matchAll(/<h2><br>\w{3} (\d{1,2}) (\w{3})[^<]*<\/h2>|<a href='\/event\/[^']*'>(?:<img[^>]*\/>)?\s*([^<]+)<\/a>\s*\((\d{2}):(\d{2}) UTC\)/g)) {
  if (m[1]) {
    day = { d: Number(m[1]), mon: MONTHS.indexOf(m[2]) };
  } else if (day && day.mon >= 0) {
    const startMs = Date.UTC(year, day.mon, day.d, Number(m[4]), Number(m[5]));
    events.push({ title: m[3].trim(), startMs, stopMs: startMs + DURATION_MS });
  }
}
events.sort((a, b) => a.startMs - b.startMs);

// The page has no sport or ranking, so "biggest" is a guess: national-team and
// rugby/AFL/NRL fixtures, then matches between big clubs. Event 1 gets the
// biggest, Event 2 the next, and so on. ponytail: keyword guess, swap for real
// sport data if the source ever provides it.
const BIG = /\b(rugby|wallabies|all blacks|springboks|australia|new zealand|afl|nrl|state of origin|manchester united|manchester city|liverpool|arsenal|chelsea|tottenham|real madrid|barcelona|bayern|juventus|inter|milan|psg)\b/gi;
const rank = (ev) => (ev.title.match(BIG) || []).length;

// Greedy slot assignment, biggest events first: first slot with no overlapping
// event already in it, so the top match of any time lands on a low slot number.
const slots = Array.from({ length: SLOTS }, () => []);
for (const ev of [...events].sort((a, b) => rank(b) - rank(a) || a.startMs - b.startMs)) {
  const n = slots.findIndex((list) => list.every((o) => o.stopMs <= ev.startMs || o.startMs >= ev.stopMs));
  if (n < 0) continue;
  ev.slot = n + 1;
  slots[n].push(ev);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 19).replace(/[-T:]/g, '')} +0000`;
let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="TheSportsDB Stan Sport AU schedule (slot assignment is a guess)">\n';
for (let n = 1; n <= SLOTS; n++) xml += `  <channel id="Stan Sport AU Event ${n}"><display-name>Stan Sport AU Event ${n}</display-name></channel>\n`;
for (const ev of events.filter((e) => e.slot)) {
  const concurrent = events.filter((o) => o.startMs < ev.stopMs && o.stopMs > ev.startMs).map((o) => o.title);
  const desc = `On Stan Sport at this time: ${concurrent.join('; ')}. Which Event slot carries which match is a best guess.`;
  xml += `  <programme start="${stamp(ev.startMs)}" stop="${stamp(ev.stopMs)}" channel="Stan Sport AU Event ${ev.slot}"><title>${esc(ev.title)}</title><desc>${esc(desc)}</desc></programme>\n`;
}
// Idle slots are not left blank: every slot gets 6-hour filler blocks over the
// coming week saying what is on Stan Sport around then, so a player never
// shows "no information" for a channel that is really a live-event slot.
const BLOCK_MS = 6 * 60 * 60 * 1000;
const first = Math.floor(Date.now() / BLOCK_MS) * BLOCK_MS;
for (let n = 1; n <= SLOTS; n++) {
  for (let t = first; t < first + 7 * 24 * 60 * 60 * 1000; t += BLOCK_MS) {
    if (slots[n - 1].some((o) => o.startMs < t + BLOCK_MS && o.stopMs > t)) continue;
    const upcoming = events.filter((o) => o.stopMs > t && o.startMs < t + 24 * 60 * 60 * 1000).map((o) => o.title);
    const desc = upcoming.length
      ? `Stan Sport live-event channel. Nothing is listed for this slot right now; on Stan Sport around this time: ${upcoming.join('; ')}.`
      : 'Stan Sport live-event channel. It shows whichever live sport Stan Sport is broadcasting; nothing is listed for this slot right now.';
    xml += `  <programme start="${stamp(t)}" stop="${stamp(t + BLOCK_MS)}" channel="Stan Sport AU Event ${n}"><title>Stan Sport Event ${n}</title><desc>${esc(desc)}</desc></programme>\n`;
  }
}
xml += '</tv>\n';
fs.writeFileSync(OUT, xml);
console.log(`stan events: ${events.length} matches in ${SLOTS} slots (+ idle-slot filler); wrote ${OUT}`);
