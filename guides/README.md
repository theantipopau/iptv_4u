# guides/

Pre-filtered XMLTV guide snapshots, hosted here (via `raw.githubusercontent.com`) specifically because Cloudflare Workers can't reliably fetch their own domain as a subrequest — a guide hosted on this app's own `/epg/<slug>.xml` can't be used as a "custom guide URL" input for this same app on Cloudflare (self-fetch to `*.workers.dev` returns 404, and to a custom domain on the same zone times out with a 522). GitHub Pages/raw content is a genuinely separate origin, so it works fine as an input.

## nz-sky-sport.xml

The 10 Sky Sport NZ channels (Sky Sport Select, 1-9, Premier League) plus ESPN and ESPN2 (channels 60/61 — bundled alongside Sky Sport on Sky Go/Sky Sport Now, not Sky Sport-branded themselves but always shown right after that block), filtered out of [nzxmltv.github.io](https://nzxmltv.github.io)'s much larger (~57MB, all 82 Sky channels) `sky/guide.xml` — which is too large for a Cloudflare Worker to fetch+parse in one request (~128MB per-isolate memory ceiling). Real programme data, not a channel-only stub: ~6,100 programmes as of the snapshot date.

**Use it**: paste `https://raw.githubusercontent.com/theantipopau/iptv_4u/main/guides/nz-sky-sport.xml` into the "Your own EPG/guide URL(s)" field (Step 2), alongside any other guide URLs you're already using.

**This is a point-in-time snapshot, not live-refreshed** — nzxmltv's own guide updates continuously; this file doesn't. Regenerate it periodically: `node scripts/trim_epgshare.mjs sky_full.xml guides/nz-sky-sport.xml "NZXMLTV Sky (trimmed to Sky Sport 1-9 + ESPN/ESPN2)" "^(5[0-9]|6[01])$"` against a fresh copy of `sky/guide.xml` — or point your custom-guide field at the full un-filtered `https://nzxmltv.github.io/sky/guide.xml` directly if you're running this app locally (`npm start`) instead of on Cloudflare — Node has no comparable size ceiling.

## au-fox-sports.xml

42 Australian pay-TV channels (Fox Sports/Fox Footy/Fox Cricket/Fox League, Foxtel Movies/One, ESPN AU, beIN Sports, Sky Racing, Racing.com) filtered out of [epgshare01.online](https://epgshare01.online)'s `epg_ripper_AU1.xml.gz` (~354 channels, ~39MB decompressed — also too large for a Cloudflare Worker to fetch in one request). Real programme data: ~4,900 programmes as of the snapshot date, plus each channel's own broadcaster-hosted icon (Foxtel/Kayo-branded, not a generic placeholder).

**Why this exists**: this app used to also discover public per-channel guides via `iptv-org/epg`'s community `workers.txt` list, but as of writing that list (and its `GUIDES.md` mirror) has collapsed to a handful of mostly-offline entries — an upstream change outside this app's control, not a bug here. `iptv-org`'s `/api/channels.json` catalog still works for identification/logos, but it never carried real schedules (`canMergeGuide` is always false for it) — so for many countries, real schedule data now has to come from a source like this one instead. epgshare01 publishes similar per-country/per-service files (`epg_ripper_<CC><n>.xml.gz`) for a lot of other regions too; if you need another country, ask Claude to trim one down the same way.

**Use it**: paste `https://raw.githubusercontent.com/theantipopau/iptv_4u/main/guides/au-fox-sports.xml` into the "Your own EPG/guide URL(s)" field, alongside any other guide URLs you're already using.

**Regenerate**: `scripts/trim_au_sports.mjs` (in this repo) re-filters a freshly downloaded `epg_ripper_AU1.xml.gz` down to the same channel id list — see the script for usage.

## uk-major.xml / us-major.xml

Same idea as `au-fox-sports.xml`, for the UK and US. `epgshare01`'s full UK file (`epg_ripper_UK1.xml.gz`) decompresses to ~22MB and its full US file (`epg_ripper_US2.xml.gz`) to ~75MB — both over the 15MB cap — so each is trimmed down to a "greatest hits" set of major national channels instead of the full regional/timezone-duplicated lineup:

- **uk-major.xml** (21 channels, ~2,100 programmes): BBC One (London feed), BBC Two, BBC Four, BBC News, ITV1-4, ITV Quiz, Channel 4 (+Film4/E4/More4), Channel 5, Sky News, and the Sky Sports channels this source happens to carry.
- **us-major.xml** (38 channels, ~4,300 programmes): the ESPN family, Fox News/Business/Sports-adjacent channels, CNN, MSNBC, and the usual major cable lineup (AMC, Bravo, Comedy Central, Discovery, Disney Channel/Junior/XD, FX/FXX, Hallmark, History, Investigation Discovery, Lifetime, National Geographic, Nickelodeon, Paramount Network, Syfy, TBS, TNT, TLC, truTV, USA, VH1, BET, Cartoon Network).

Neither pretends to be exhaustive — US broadcast network affiliates (ABC/NBC/CBS/FOX) are market-specific in this source with no single canonical id, so they're skipped entirely; ask Claude to add more channels/countries the same way if something you need is missing.

**Use them**: paste `https://raw.githubusercontent.com/theantipopau/iptv_4u/main/guides/uk-major.xml` and/or `.../us-major.xml` into the "Your own EPG/guide URL(s)" field.

**Regenerate**: `scripts/trim_epgshare.mjs` is the generalized version of `trim_au_sports.mjs` — instead of an exhaustive id list, it takes regex patterns on the command line, so re-trimming (or trimming a new country) doesn't require editing a script. See the script's header comment for exact usage. Some `epgshare01` files that fit under the 15MB cap as-is need no trimming at all — e.g. South Africa's `epg_ripper_ZA1.xml.gz` (~2.9MB decompressed, includes the full SuperSport lineup with real schedules) can be pasted directly into the "Your own EPG/guide URL(s)" field with no repo changes.
