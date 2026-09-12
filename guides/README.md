# guides/

Pre-filtered XMLTV guide snapshots, hosted here (via `raw.githubusercontent.com`) specifically because Cloudflare Workers can't reliably fetch their own domain as a subrequest — a guide hosted on this app's own `/epg/<slug>.xml` can't be used as a "custom guide URL" input for this same app on Cloudflare (self-fetch to `*.workers.dev` returns 404, and to a custom domain on the same zone times out with a 522). GitHub Pages/raw content is a genuinely separate origin, so it works fine as an input.

## nz-sky-sport.xml

All 10 Sky Sport NZ channels (Sky Sport Select, 1-9, Premier League) filtered out of [nzxmltv.github.io](https://nzxmltv.github.io)'s much larger (~57MB, all 82 Sky channels) `sky/guide.xml` — which is too large for a Cloudflare Worker to fetch+parse in one request (~128MB per-isolate memory ceiling). Real programme data, not a channel-only stub: ~5,270 programmes as of the snapshot date.

**Use it**: paste `https://raw.githubusercontent.com/theantipopau/iptv_4u/main/guides/nz-sky-sport.xml` into the "Your own EPG/guide URL(s)" field (Step 2), alongside any other guide URLs you're already using.

**This is a point-in-time snapshot, not live-refreshed** — nzxmltv's own guide updates continuously; this file doesn't. Regenerate it periodically (ask Claude to re-filter a fresh copy of `sky/guide.xml` down to channel ids 50-59 and commit it here), or point your custom-guide field at the full un-filtered `https://nzxmltv.github.io/sky/guide.xml` directly if you're running this app locally (`npm start`) instead of on Cloudflare — Node has no comparable size ceiling.

## au-fox-sports.xml

42 Australian pay-TV channels (Fox Sports/Fox Footy/Fox Cricket/Fox League, Foxtel Movies/One, ESPN AU, beIN Sports, Sky Racing, Racing.com) filtered out of [epgshare01.online](https://epgshare01.online)'s `epg_ripper_AU1.xml.gz` (~354 channels, ~39MB decompressed — also too large for a Cloudflare Worker to fetch in one request). Real programme data: ~4,900 programmes as of the snapshot date, plus each channel's own broadcaster-hosted icon (Foxtel/Kayo-branded, not a generic placeholder).

**Why this exists**: this app used to also discover public per-channel guides via `iptv-org/epg`'s community `workers.txt` list, but as of writing that list (and its `GUIDES.md` mirror) has collapsed to a handful of mostly-offline entries — an upstream change outside this app's control, not a bug here. `iptv-org`'s `/api/channels.json` catalog still works for identification/logos, but it never carried real schedules (`canMergeGuide` is always false for it) — so for many countries, real schedule data now has to come from a source like this one instead. epgshare01 publishes similar per-country/per-service files (`epg_ripper_<CC><n>.xml.gz`) for a lot of other regions too; if you need another country, ask Claude to trim one down the same way.

**Use it**: paste `https://raw.githubusercontent.com/theantipopau/iptv_4u/main/guides/au-fox-sports.xml` into the "Your own EPG/guide URL(s)" field, alongside any other guide URLs you're already using.

**Regenerate**: `scripts/trim_au_sports.mjs` (in this repo) re-filters a freshly downloaded `epg_ripper_AU1.xml.gz` down to the same channel id list — see the script for usage.
