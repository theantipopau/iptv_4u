<p align="center">
  <img src="public/assets/logo.png" alt="IPTV 4U logo" width="160" />
</p>

<h1 align="center">IPTV 4U</h1>

<p align="center">Turn a raw M3U playlist into a correctly logo'd, correctly EPG'd M3U + XMLTV pair — then host the result at a stable URL your IPTV player can point at.</p>

## What it does

Point it at an `.m3u` playlist (an existing XMLTV guide is optional — without one, it starts a fresh guide):

1. **Parses** every channel out of the playlist.
2. **Searches** two kinds of online sources for each channel: the [iptv-org/epg](https://github.com/iptv-org/epg) worker network (real per-channel schedules) and the [iptv-org/api](https://github.com/iptv-org/api) catalog (channel metadata + logos, no schedule) — plus any guide URL(s) of your own (see below).
3. **Scores matches** with country-aware fuzzy matching — "Sky Sports 1 NZ" won't get matched to the UK feed of the same name — plus a fast path for channels whose M3U already carries a correct `tvg-id`.
4. **Detects 24/7 / marathon / non-stop channels** by name (e.g. `24/7 Band of Brothers [VIP]`), strips the decoration to get a clean title, and — if you've configured a TMDB key — looks up the actual movie/show for its poster art and title, since there's no real schedule to merge for a looping channel.
5. **Merges** whatever was found — a real schedule, a logo, or a synthesized placeholder schedule for identified 24/7 content — into your XMLTV file, and writes `tvg-logo` back into the M3U.
6. **Exports** the result as downloadable files, or **publishes** it to a stable URL your player app can point at directly, optionally kept fresh automatically (see below).

The channel table supports sorting (click a column header), bulk actions (select rows → re-match or clear links together), and inline editing — click a `tvg-id` cell, or the small pencil icon on a logo, to set either one manually. A live stats bar in the header tracks how many channels have a full guide, logo-only, or no link at all as you go. Anything you fix manually can be exported as a reusable **channel backlog** (see below) instead of needing the same fix again next time.

## Architecture

```
shared/                 platform-agnostic core: parsing, matching, XMLTV
                         building, 24/7 detection, TMDB lookup, EPG source
                         discovery, publishing — no fs, no Node built-ins,
                         no Express, no Cloudflare-specific APIs
shared/core.js           pure functions: M3U/XMLTV parsing & building,
                         scoreMatch, country hints, 24/7 detection
shared/fetch-utils.js     fetch-with-timeout, gzip decompression
                         (Web-standard DecompressionStream — works
                         identically in Node and Workers), size-capped
                         streaming reads, concurrency
shared/epg-service.js     orchestration: every route's actual logic,
                         taking a pluggable cache adapter
shared/node-cache.js      filesystem cache adapter (local/self-hosted)
shared/kv-cache.js        Cloudflare KV cache adapter (same {get,
                         getStale, set} shape as the Node one)
server.js                Express app for `npm start` (local/self-hosted)
worker.js                 Cloudflare Worker entry point — one fetch
                         handler routing /api/*, /iptv/*.m3u, /epg/*.xml,
                         a scheduled() handler for auto-refresh, falling
                         back to static assets for everything else
public/                  static frontend — identical against either backend
public/index.html, app.js  the M3U/EPG linker (import, match, review, export, publish)
public/watch.html, watch.js  the /watch live viewer — DOM/browser glue only
public/watch-core.js      pure viewer logic (parsing, now/next, error
                         classification, redaction) — no DOM references,
                         so tests/*.test.mjs import it directly under Node
public/service-worker.js  PWA app-shell cache; explicit deny-first rules
                         for anything playlist/guide/stream-related
public/manifest.webmanifest  PWA manifest
guides/                  pre-filtered XMLTV snapshots checked into the
                         repo for use as custom guide URLs (see below)
tests/                   node:test unit tests (no framework dependency) —
                         run with `npm test`
```

Both entry points expose the exact same routes and call the same `shared/` logic — the frontend in `public/` doesn't know or care which one it's talking to, and a matching-logic fix only needs to land in one place.

**Why two entry points, and why a single `worker.js`?** Cloudflare's "Connect to Git" flow (as of when this was built, Sep 2026) creates a unified **Worker with static assets**, not a classic Pages project — which means the old per-file `functions/api/*.js` routing convention doesn't apply here at all; it needs one `main` script declared in `wrangler.toml` that handles routing itself and falls back to `env.ASSETS.fetch()` for static files. Locally, none of this matters — `server.js`/Express has no filesystem restrictions, so it just uses the disk cache directly.

## Quick start (local)

```bash
npm install
npm start
```

Then open http://localhost:3000 — no XMLTV file needed to start, just an M3U.

**Tests**: `npm test` (Node's built-in `node:test`/`assert` — no test framework dependency). Covers `public/watch-core.js` (M3U/XMLTV parsing, now/next selection, HTTPS-upgrade construction, URL redaction, error classification) and `shared/core.js`'s alias registry. These are unit tests for pure logic, not a browser automation suite — playback itself is verified manually against real streams (see **Watching in the browser**).

## API reference

Every route below is implemented once in `shared/epg-service.js` and exposed identically by both `server.js` (local) and `worker.js` (Cloudflare) — same paths, same request/response shapes, no authentication on either (this is a personal/self-hosted tool, not a multi-tenant service — see the security note under Publishing).

| Route | Body / query | Response |
|---|---|---|
| `GET /api/discover-sources?refresh=1` | — | `{ ok, count, sources: [{ id, name, host, channelsUrl, guideUrl }] }`. `refresh=1` forces a live re-fetch of the worker list instead of the cached one. |
| `POST /api/parse-files` | `{ m3uContent, xmlContent? }` | `{ ok, m3uChannels, xmlContent, xmlSummary: { channelCount, programmeCount, channels } }`. `xmlContent` is optional — an empty guide stub is generated and returned if omitted. |
| `POST /api/search-channel` | `{ channelName, tvgId?, groupTitle?, maxSources?, customGuideUrl? }` (`customGuideUrl`: one URL per line or comma-separated) | `{ ok, query, searchedSources, context: { isTwentyFourSeven, cleanedTitle, countryHint, tmdbConfigured }, matches: [{ sourceType, source, score, channelName, channelId, logoUrl, guideUrl?, canMergeGuide, tmdb? }] }` |
| `POST /api/merge-guide` | `{ baseXml, guideUrl, channelId, preferredName?, logoUrl? }` | `{ ok, mergedXml, addedProgrammes, addedChannelId, addedChannelName }` |
| `POST /api/apply-identity` | `{ baseXml, channelId, channelName?, logoUrl?, synthesize?, title?, overview?, days? }` | `{ ok, mergedXml, addedChannelId, addedProgrammes }` |
| `POST /api/export-m3u` | `{ channels, links }` | `{ ok, m3u }` |
| `POST /api/publish` | `{ slug, m3uContent?, xmlContent? }` (at least one content field) | `{ ok, slug }` — then served at `/iptv/<slug>.m3u` and/or `/epg/<slug>.xml` |
| `POST /api/refresh-config` | `{ slug, m3uUrl, customGuideUrl?, intervalKey? }` (`intervalKey`: `"6h"`, `"12h"`, `"24h"`, or `null`/omitted for off) | `{ ok, config }` |
| `GET /api/refresh-config/:slug` | — | `{ ok, config }` (`config: null` if nothing saved for that slug) |
| `POST /api/refresh-now` | `{ slug }` | Runs the saved config's fetch→match→publish pipeline immediately. `{ ok, config }`, updated with `lastRunAt`/`lastRunStatus`/`lastRunChannelCount`/etc. |
| `GET /iptv/:slug.m3u` | — | The published playlist. `404` if nothing's been published under that slug. |
| `GET /epg/:slug.xml` | — | The published guide. `404` if nothing's been published under that slug. |

Every remote fetch (a custom guide URL, an auto-refresh's M3U source, a worker's channel list) is capped at 15MB, checked both via `Content-Length` and while streaming — see **Notes** for why, and **`guides/`** below for the workaround when a source you want is larger than that.

## Publishing to a stable URL (TiViMate, etc.)

Downloading updated files works, but re-uploading them into a player app every time you re-run a match is tedious. Step 5 in the UI ("Publish") instead saves the final M3U/XML to the server under a slug you choose and gives you back two stable URLs:

```
https://iptv4u.matthurley.dev/iptv/matt.m3u
https://iptv4u.matthurley.dev/epg/matt.xml
```

Point TiViMate (or any player that takes a playlist/EPG URL) at those, and re-publishing later updates the same URLs in place — no need to touch the player app again.

> **These URLs are public and unauthenticated.** Anyone who knows the exact slug can fetch your playlist and channel stream URLs. Pick a slug that isn't trivially guessable if your provider embeds private access tokens in the stream URLs (many IPTV services do) — treat the link like a password, not a username.

Publishing needs somewhere to persist the files: locally that's `.hosted-files/` on disk; on Cloudflare it's the `HOSTED_FILES` KV namespace (below).

## Deploying to Cloudflare

Dashboard for the KV namespace IDs and the Secrets Store setup; `wrangler.toml` for everything else. No API token needs to change hands for this.

1. **Push this repo to GitHub** (or GitLab).
2. **Workers & Pages → Create → Import a repository** (or **Connect to Git**) → pick the repo. Cloudflare will build it as a **Worker with static assets**, using `worker.js` as the entry point and `public/` as the asset directory — both declared in `wrangler.toml`, so the build settings fields (build/deploy command) can stay blank.
3. **Workers & Pages → KV → Create namespace**, twice: one for the EPG cache (e.g. `iptv4u-epg-cache`), one for published files (e.g. `iptv4u-hosted-files`). Open each namespace and copy its **id**.
4. Edit `wrangler.toml` in the repo, replacing the two placeholder KV ids with the real ones from step 3, then push.
5. TMDB (optional, see below) needs a **Secrets Store** binding, not the plain "Runtime variables and secrets" table on the Worker's own Settings page — see the TMDB section for why and how.
6. **Settings → Domains & Routes** → add your custom domain (e.g. `iptv4u.matthurley.dev`) — Cloudflare wires the DNS record automatically since the domain's already on your account.
7. The Cron Trigger for auto-refresh (`[triggers]` in `wrangler.toml`) should show up under **Settings → Trigger events** once deployed — if it doesn't, it can also be added there directly (schedule: `0 * * * *`, i.e. hourly).

### Troubleshooting

- **TMDB key keeps disappearing — `tmdbConfigured` stays `false` no matter how many times you re-add it.** This is [cloudflare/workers-sdk#8871](https://github.com/cloudflare/workers-sdk/issues/8871), a known, currently-open Cloudflare bug: values in the Worker's **Settings → Variables and secrets** table get silently wiped on every deploy that comes through the GitHub integration — confirmed by testing, not a guess. Don't use that table for `TMDB_API_KEY` at all; use the **Secrets Store** binding described below, which is config-as-code (declared in `wrangler.toml`, same pattern as the KV bindings) and isn't affected by this bug.
- **Every `/api/*` route 404s, but the site itself loads fine.** This is what happens if `worker.js` isn't actually being deployed as the Worker's script — e.g. `wrangler.toml` is missing, or its `main`/`[assets]` fields got reverted. Only the static half of the deploy runs in that case, which serves `/` and `/app.js` correctly but leaves nothing to handle `/api/*`, `/iptv/*`, or `/epg/*`.
- **"Missing entry-point to Worker script" during build.** `wrangler.toml` is missing `main`, or points at a file that doesn't exist. Confirm it's set to `main = "worker.js"`.
- **KV reads/writes silently do nothing.** The `id` fields in `wrangler.toml` are still the `REPLACE_WITH_...` placeholders — swap them for the real namespace ids (step 3/4 above).
- **A custom guide URL never seems to produce a match, even though it loads fine in a browser.** Check its size — anything over 15MB is rejected (see Notes) to avoid crashing the whole Worker invocation (Workers have a ~128MB per-isolate memory ceiling; parsing a large XML into an object graph can blow well past that). See `guides/` below for the standard workaround.
- **A guide/playlist you host on this same app 404s or times out when used as a custom guide URL for this same app.** Cloudflare Workers can't reliably fetch their own domain as a subrequest (confirmed: a `*.workers.dev` self-fetch returns 404, a custom-domain self-fetch on the same zone times out with a 522). Host it somewhere genuinely external instead — `raw.githubusercontent.com` (see `guides/`) works fine.

## Optional: 24/7 channel art via TMDB

1. Get a free "API Key (v3 auth)" from your account settings at https://www.themoviedb.org/settings/api
2. **Local**: copy `.env.example` to `.env`, set `TMDB_API_KEY=...`, restart the server.
3. **Cloudflare**: set it up as a **Secrets Store** binding, not a plain dashboard variable (see Troubleshooting above for why):
   - **Storage & databases → Secrets Store** (left sidebar) → **Create secret** → name it e.g. `tmdb-api-key`, paste your TMDB key as the value.
   - Copy the **Store ID** shown on that page.
   - Add this to `wrangler.toml` (safe to commit — no actual key value goes in this file, just a reference by name):
     ```toml
     [[secrets_store_secrets]]
     binding = "TMDB_API_KEY"
     store_id = "<your store id>"
     secret_name = "tmdb-api-key"
     ```
   - Push. `worker.js` resolves it via `await env.TMDB_API_KEY.get()` (a Secrets Store binding is an object with an async `.get()`, not a plain string like the old dashboard variable was) — already wired up, no further code changes needed.

Without a key, 24/7 channels are still detected and flagged in the UI — they just won't get automatic poster art, and you can still search/link them manually. Many well-known 24/7/FAST channels (a real "Bluey" or Pluto TV channel, for instance) already resolve for free from `iptv-org`'s own catalog without needing TMDB at all — TMDB is the fallback for channels nobody's indexed.

## Using your own IPTV provider's EPG

Step 2 in the UI has a "Your own EPG/guide URL(s)" field — one URL per line (or comma-separated) to combine more than one. If your provider gives you an XMLTV guide URL (many do, alongside the M3U), paste it there — every one listed is fetched and matched alongside the public sources on every search/auto-match, no scan-limit applied since these are explicit sources, not part of the ~300-host public network. For a provider whose M3U already tags channels with a `tvg-id` that matches a guide's own channel `id`s (common — it's usually the same underlying dataset), this resolves real schedules for nearly every linear channel in one pass, which the sparse public worker network usually can't.

Combining more than one is genuinely useful, not just a convenience: a general-lineup guide from your own provider won't necessarily cover a country-specific channel group the way a dedicated regional guide does. For New Zealand specifically, [nzxmltv.github.io](https://nzxmltv.github.io) is a community-maintained, publicly-hosted set of XMLTV guides (Freeview, Sky, Red Bull TV, Pluto TV, ThreeNow) with real per-channel schedules including all of Sky Sport 1-9. Its full `sky/guide.xml` is ~57MB (all 82 Sky channels, way over the 15MB fetch cap) — `guides/nz-sky-sport.xml` in this repo is a pre-filtered snapshot (just the 10 Sky Sport channels, real programme data, ~6.5MB) checked in specifically to stay under that cap; see `guides/README.md` for how to regenerate it, and use its `raw.githubusercontent.com` URL as one of your custom guide URLs.

### Building your own channel backlog

For channels nothing automatic can resolve at all (a channel number the public catalog just doesn't track, a provider-specific rebrand, ...), inline-edit the `tvg-id` and/or logo directly in the table — then **Step 6 → "Export Channel Backlog (XMLTV)"** exports every channel you've manually fixed as a small channel-only XMLTV file (id/name/icon, no programmes). Commit it to your own repo (the `guides/` folder is a natural place) and add its raw URL to the custom guide URL field: future re-imports of the same provider lineup resolve those channels automatically, without needing the same manual fix again — a backlog you own and control, independent of what the public catalogs happen to track.

## Keeping a published playlist fresh automatically

Step 5 also has an auto-refresh section: give it an M3U **URL** (instead of just a one-off file upload) and a refresh interval, and it periodically re-fetches that URL, re-matches every channel from scratch, and re-publishes under the same slug — no need to come back and re-upload every time your provider updates the lineup.

- **Local**: use "Refresh Now" to trigger it on demand. There's no background scheduler for `npm start` — if you want it automatic locally too, point your own OS-level cron/task scheduler at `POST /api/refresh-now` with `{"slug": "..."}`.
- **Cloudflare**: a Cron Trigger (`wrangler.toml`'s `[triggers]`, fires hourly) checks every saved config and runs any that are actually due per their own interval — Cloudflare only supports fixed cron schedules, not one per user, hence the hourly tick + due-check rather than a genuinely per-config schedule.
- Channels are matched with bounded concurrency (5 at a time) and guide files are fetched once per distinct URL per run (not once per channel that happens to resolve to the same guide) — the config, and cache design generally, are built to keep this from blowing out subrequest/CPU budgets even on large lineups. Very large playlists may still want a paid Workers plan; "Refresh Now" is the way to check before relying on the schedule.

## Watching in the browser

Once a playlist is published (above), `/watch?slug=<slug>` is a mobile-friendly viewer for it — the core experience is watching directly in the browser, not handing off to TiViMate/VLC. It fetches `/iptv/<slug>.m3u` (and `/epg/<slug>.xml`, if one was published too) client-side; **there is no server-side relay or proxy, and none is planned** — playback only ever works for streams the *browser itself* can reach and decode directly. That's a deliberate design boundary, not an oversight: a relay/transcode gateway is real infrastructure (a persistent process, likely FFmpeg, a cost commitment) that doesn't fit a Cloudflare Workers free-tier deployment, and this app won't add one silently. See **Why no relay/FFmpeg** below.

Logic that doesn't need a DOM (M3U/guide parsing, favourites/recents, error classification, URL redaction, HTTPS-upgrade construction) lives in `public/watch-core.js`, a plain ES module with no browser-only globals — it's what `public/watch.js` imports, and it's exactly what `tests/watch-core.test.mjs` and `tests/alias-registry.test.mjs` exercise directly under Node (`npm test`), so this logic is unit-tested without a browser automation stack.

### Playback pipeline

1. **Native HLS** (Safari/iOS) for a `.m3u8` URL, when the browser can play it without help.
2. **[hls.js](https://github.com/video-dev/hls.js)** (pinned version, loaded from cdnjs) for `.m3u8` elsewhere — Media Source Extensions in the browser, not a native decoder.
3. **[mpegts.js](https://github.com/xqq/mpegts.js)** for a raw, continuous MPEG-TS stream — the common case for most IPTV playlists (no `.m3u8` manifest at all), which no browser decodes natively.
4. A clear, specific explanation when none of the above can play the stream — never a silent failure, and never a hand-off to an external app as part of the normal flow.

Every playback attempt gets a monotonically increasing attempt id; every async callback (hls.js events, mpegts.js events, native `<video>` events, the load watchdog) checks it's still current before touching any UI state, so a slow failure from a channel you've already switched away from can't overwrite what you're watching now. Confirmed via rapid-switch testing, not just by inspection.

If a stream is plain `http://` and the page is HTTPS, it tries the identical URL with `https://` substituted first (some providers serve both silently, without the M3U ever being updated) — this runs at most once per attempt, never touches the channel's stored URL, and only fires for this specific http-on-https case. Failing that, it explains the real, unfixable-client-side reason: browsers block insecure video on a secure page, full stop.

### Error messages

Every failure is classified into one of a fixed set of named categories (`shared`/`watch-core.js`'s `classifyPlaybackError`) with a specific plain-language message — `HTTP_MIXED_CONTENT`, `HTTPS_UPGRADE_FAILED`, `MANIFEST_LOAD_FAILED`, `MANIFEST_PARSE_FAILED`, `MEDIA_NETWORK_ERROR`, `MEDIA_DECODE_ERROR`, `AUTH_EXPIRED`, `LOAD_TIMEOUT`, `AUTOPLAY_BLOCKED`, `UNSUPPORTED_FORMAT`, `UNKNOWN` — sourced from hls.js's/mpegts.js's own stable error codes (never a guess, and never "CORS" by default for an otherwise-unexplained failure). A 15s watchdog covers the case where a stream neither errors nor starts. A **"Technical details"** disclosure under the player shows the full diagnostic record (redacted host/path only — never a full stream URL, query string, or credential), with a **"Copy diagnostic"** button for pasting into a bug report.

### Now/next guide

Parses the published XMLTV once per load (a small regex-based extractor in `watch-core.js`, not `DOMParser` — that's what lets the exact same function run under Node for tests) into a per-channel programme index. Shows the current programme with a live progress bar and the next one, both per-row in the channel list and in the now-playing panel; a 60s interval patches just the now/next text in place rather than re-rendering the list, so scrolling and search state survive the refresh. Honors XMLTV's UTC-offset timestamps directly (no separate DST calculation needed — the offset in the timestamp already accounts for it). A synthesized 24/7 placeholder guide entry (see **Optional: 24/7 channel art via TMDB**) is tagged via its own `<category>24/7</category>` marker and shown as "(estimated — no verified schedule)", never presented as a real schedule.

### Favourites, recently watched, sleep timer

A star toggle per channel and a **favourites-only** filter, plus a horizontal **recently watched** row — both keyed by the channel's `tvg-id` (falling back to its name), not its position in the list, so a republished playlist that reorders or drops channels doesn't corrupt either list; stale entries for a channel that's disappeared are pruned automatically on load. Both persist in `localStorage` per slug. A **sleep timer** (15/30/60/90 minutes, or "end of programme" when now/next data is available) stops playback cleanly and shows a brief confirmation instead of just going silent.

### Mobile

Touch targets sized to ~44px throughout, `env(safe-area-inset-*)` respected on notched phones, hover states swapped for `:active` below 640px (a stuck hover highlight is a touch-only annoyance, not a desktop one), a side-by-side layout in landscape instead of the default stacked one, keyboard navigation (every channel row and control is a real focus target with a visible focus ring), and `prefers-reduced-motion` honored.

### Installable as a PWA

`manifest.webmanifest` + `service-worker.js` make `/watch` installable on a phone's home screen. The service worker caches the static shell only (HTML/CSS/JS/icons) — it has an explicit **deny-first** rule for anything playlist-, guide-, or stream-related (`/iptv/*`, `/epg/*`, `/api/*`, any response whose `Content-Type` looks like media/manifest data) that always goes straight to the network, never into the cache, regardless of path. Offline, the shell still loads with a clear "live channels need a network connection" banner — it does not pretend to play anything without one.

### Known limitation, not fixable client-side

A stream whose server doesn't allow cross-origin browser access, or that's HTTP-only with no HTTPS equivalent, won't play here even though it works fine in TiViMate/VLC — those aren't bound by the browser sandbox this viewer runs in. TiViMate remains the reliable fallback for anything that hits this wall; it's a fallback, not the primary workflow.

### Why no relay/FFmpeg

A browser-side player can only do so much — some streams are genuinely only reachable with server help (CORS, mixed content with no HTTPS equivalent, a header the provider requires). Building that properly (an authenticated, SSRF-hardened relay; HLS manifest rewriting that also handles keys/subtitles/alternate audio; a real FFmpeg remux/transcode gateway with session lifecycle management) is a legitimate multi-week engineering effort with real, ongoing infrastructure cost — not something this project takes on silently for a personal, free-tier Cloudflare Workers deployment. If that's ever wanted, it's a deliberate, scoped decision to make explicitly, not a default.

## How matching actually works

- **Exact `tvg-id`**: if your M3U already carries a `tvg-id` that matches a known source's channel id (including your own custom guide, if you've set one), that's scored 1.0 and wins outright.
- **Country hints**: pulled from bracketed/prefixed/suffixed country codes or full country names in the channel name/`group-title` (e.g. `(NZ)`, `UK:`, `Sky Sports NZ`), then used to boost same-country matches and penalize cross-country name collisions — normalized consistently on both sides (iptv-org's own data uses the literal string `"UK"` as a country value in places, not ISO `"GB"`; comparing a normalized hint against a raw candidate value was silently *penalizing* correct same-country matches until this was fixed).
- **24/7 detection**: a regex over `24/7`, `24-7`, `nonstop`, `marathon`, `all day`, `loop(ed)` in the name or group. Once flagged, matching switches to scoring against the *cleaned* title only (decoration stripped, including season/episode markers like "Season 6" or "S07") — scoring against the raw name would let a channel literally named "24/7" win by substring containment against every other 24/7-flagged query, which is exactly the failure mode this avoids.
- **Word-ratio containment, not a flat floor**: a short cleaned title only counts as "contained" in a candidate name when it's a whole word (not, e.g., "Tron" matching mid-word inside "Armstrong"), and the score is the *fraction of the longer name's words* the shorter one accounts for — not a flat "at least 0.65/0.75". A flat floor is exactly what let a channel literally named "Sport" outrank a real identification for "Stan Sport AU Event 1", or a channel named "Band" beat "Band of Brothers": one matching word out of five (or three) is a weak signal, and now scores like one.
- **Generic words count for less**: broadcast-industry filler ("Network", "Channel", "Sport(s)", "News", "TV", country codes, ...) and bare 1-2 digit numbers score at a fraction of a real word, in both the word-ratio containment above and plain token overlap. Without this, "Lifetime Network" matched "ACC Network" on the word "Network" alone, and a channel literally named "Arig Us" (a Russian broadcaster) matched a US ESPN query purely on the bare token "us".
- **A specific 2+ digit number that doesn't match anywhere is a strong negative signal**: "Fox Sports 502" and "Fox Sports 501" share every word except the one that actually distinguishes them — generic-word overlap alone used to be enough to match the wrong numbered channel (or the wrong catalog entry entirely) when the exact number a query asked for isn't tracked anywhere. A 2+ digit number present on one side and absent from the other (whether the other side has a *different* number or none at all) now caps the score well below any match threshold. 1-2 digit numbers are unaffected (already down-weighted as generic on their own).
- **Spacing-insensitive equality**: "ITV 1" and "ITV1" collapse to the same alphanumeric string and score as a near-exact match — a common enough M3U-vs-catalog naming difference (space around a trailing number) that it's worth checking for directly rather than relying on token overlap to catch it.
- **Confidence bar**: general matches need a score ≥0.45–0.48 depending on source; 24/7-flagged matches need ≥0.6, since a wrong identification (wrong poster, wrong logo) is worse than none.
- **Source prioritization**: a single search can't scan every EPG worker source (there are ~300, and Cloudflare's free-plan subrequest limits cap this at 40 per request) — sources are ranked by whether their host name matches the channel's country hint or name tokens before slicing to the scan limit, so a niche source is more likely to actually get checked.
- **Curated alias registry** (`shared/core.js`'s `CHANNEL_ALIAS_REGISTRY`): a small, versioned list of real-world channel identity facts iptv-org's own catalog doesn't fully carry — a channel number, a platform-specific rebrand name (Kayo Sports vs. Foxtel's own Fox Sports numbering, DStv's SuperSport branding), or a legacy/alternate EPG id. Two things it feeds: existing catalog entries missing their own `alt_names` (so "Fox Sports 502" or "Kayo League" resolves to the catalog's "Fox League" entry, which upstream carries none of those names itself), and channels the public catalog doesn't carry *at all* (ESPN NZ/ESPN2 NZ, confirmed absent upstream — these are only otherwise identifiable via a matching worker/custom-guide source). A channel number alone never triggers a match by itself — it's reference metadata, not part of the matched text, since providers reuse the same number for unrelated channels. Seeded with every AU Fox Sports/Kayo, NZ Sky Sport, and ZA SuperSport mapping found during real-playlist debugging; not exhaustive by design. Covered by `tests/alias-registry.test.mjs`.

## Notes

- Online discovery results are cached (disk locally, KV on Cloudflare) so requests don't need to re-probe every host or re-download the full IPTV-org API each time. If a live fetch fails, it falls back to serving the last cached copy rather than failing outright.
- `guides.json` from iptv-org is ~180k rows (~25MB) but only ~31k are actually mapped to a channel id — pruned before caching, both to stay well under Cloudflare KV's 25MB per-value limit and because the rest is dead weight either way.
- **Every remote fetch (custom guide URLs, worker channel lists, auto-refresh's M3U source) is capped at 15MB.** Cloudflare Workers have a ~128MB per-isolate memory ceiling, and a large XMLTV guide parses into an in-memory object graph several times the size of its raw bytes — a 50MB+ guide crashes the whole Worker invocation outright (an opaque Cloudflare "error 1102") rather than just failing the one request that triggered it. The cap is enforced identically on both platforms (Node has far more headroom and would handle a bigger file fine, but a consistent, predictable limit beats one that silently depends on which backend happens to be running). If a source you want is larger, filter it down first — see `guides/README.md` for how this was done for the NZ Sky Sport guide.
- Not every internet EPG is indexable from one source, but you can add custom guide/channel URLs in the UI and include them in matching — see **Using your own IPTV provider's EPG** above.
- 24/7-channel placeholder guides are just that — a single all-day `<programme>` block per day with the identified title, not a real schedule.
- Progress autosaves to the browser (`localStorage`); "Save Project File" / "Load Project File" gives you a portable `.json` backup of the same state.
