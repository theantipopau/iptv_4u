<p align="center">
  <img src="public/assets/logo.png" alt="IPTV 4U logo" width="160" />
</p>

<h1 align="center">IPTV 4U</h1>

<p align="center">Turn a raw M3U playlist into a correctly logo'd, correctly EPG'd M3U + XMLTV pair — then host the result at a stable URL your IPTV player can point at.</p>

## What it does

Point it at an `.m3u` playlist (an existing XMLTV guide is optional — without one, it starts a fresh guide):

1. **Parses** every channel out of the playlist.
2. **Searches** two kinds of online sources for each channel: the [iptv-org/epg](https://github.com/iptv-org/epg) worker network (real per-channel schedules) and the [iptv-org/api](https://github.com/iptv-org/api) catalog (channel metadata + logos, no schedule).
3. **Scores matches** with country-aware fuzzy matching — "Sky Sports 1 NZ" won't get matched to the UK feed of the same name — plus a fast path for channels whose M3U already carries a correct `tvg-id`.
4. **Detects 24/7 / marathon / non-stop channels** by name (e.g. `24/7 Band of Brothers [VIP]`), strips the decoration to get a clean title, and — if you've configured a TMDB key — looks up the actual movie/show for its poster art and title, since there's no real schedule to merge for a looping channel.
5. **Merges** whatever was found — a real schedule, a logo, or a synthesized placeholder schedule for identified 24/7 content — into your XMLTV file, and writes `tvg-logo` back into the M3U.
6. **Exports** the result as downloadable files, or **publishes** it to a stable URL your player app can point at directly (see below).

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
                         identically in Node and Workers), concurrency
shared/epg-service.js     orchestration: every /api/* route body, taking
                         a pluggable cache adapter
shared/node-cache.js      filesystem cache adapter (local/self-hosted)
functions/_lib/kv-cache.js  Cloudflare KV cache adapter
server.js                thin Express wrapper around shared/ — `npm start`
functions/api/*.js        thin Cloudflare Pages Functions wrapper around
                         the same shared/ code
functions/iptv/[[path]].js  serves a published playlist: /iptv/<slug>.m3u
functions/epg/[[path]].js   serves a published guide: /epg/<slug>.xml
public/                  static frontend — identical against either backend
```

Both backends expose the exact same `/api/*` routes and the same `shared/` logic — the frontend in `public/` doesn't know or care which one it's talking to, and a matching-logic fix only needs to land in one place.

**Why two backends?** Cloudflare Pages Functions run in a serverless edge sandbox with no filesystem, so the disk-based EPG cache (`.epg-cache/`) doesn't work there — `functions/_lib/kv-cache.js` is the same `{get, getStale, set}` adapter shape backed by Cloudflare KV instead. Everything else is shared.

## Quick start (local)

```bash
npm install
npm start
```

Then open http://localhost:3000 — no XMLTV file needed to start, just an M3U.

## Publishing to a stable URL (TiViMate, etc.)

Downloading updated files works, but re-uploading them into a player app every time you re-run a match is tedious. Step 5 in the UI ("Publish") instead saves the final M3U/XML to the server under a slug you choose and gives you back two stable URLs:

```
https://iptv4u.matthurley.dev/iptv/matt.m3u
https://iptv4u.matthurley.dev/epg/matt.xml
```

Point TiViMate (or any player that takes a playlist/EPG URL) at those, and re-publishing later updates the same URLs in place — no need to touch the player app again.

> **These URLs are public and unauthenticated.** Anyone who knows the exact slug can fetch your playlist and channel stream URLs. Pick a slug that isn't trivially guessable if your provider embeds private access tokens in the stream URLs (many IPTV services do) — treat the link like a password, not a username.

Publishing needs somewhere to persist the files: locally that's `.hosted-files/` on disk; on Cloudflare it's the `HOSTED_FILES` KV binding (step 4 below).

## Deploying to Cloudflare Pages

All dashboard-based — no API token needed from me or you to hand over.

1. **Push this repo to GitHub** (or GitLab).
2. **Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
3. Build settings: **Build command** — leave blank (there's nothing to build, it's plain static files + Functions). **Build output directory** — `public`.
4. **Workers & Pages → KV → Create namespace**, twice: one for the EPG cache (e.g. `iptv4u-epg-cache`), one for published files (e.g. `iptv4u-hosted-files`).
5. On the Pages project: **Settings → Functions → KV namespace bindings** — add two bindings, named *exactly*:
   - `EPG_CACHE` → the first namespace
   - `HOSTED_FILES` → the second namespace
6. **Settings → Environment variables** → add `TMDB_API_KEY` (optional, see below) as a secret.
7. Deploy, then **Custom domains** tab on the Pages project → add your subdomain (e.g. `iptv4u.matthurley.dev`) — Cloudflare wires the DNS record automatically since the domain's already on your account.

### Troubleshooting: "Missing entry-point to Worker script"

If a build fails with wrangler complaining about a missing entry-point / `wrangler deploy` instead of `wrangler pages deploy` — that means a `wrangler.toml` (or `wrangler.jsonc`) exists at the repo root. Its presence switches Cloudflare's Git-connected build off the normal static-Pages-plus-Functions flow and onto a generic Workers deploy, which this project isn't set up for. This repo intentionally has **no** `wrangler.toml` for that reason; if you add one back (e.g. for local `wrangler pages dev`), expect to also need to explicitly set the project's **Deploy command** in dashboard settings to override the auto-detected one.

## Optional: 24/7 channel art via TMDB

1. Get a free "API Key (v3 auth)" from your account settings at https://www.themoviedb.org/settings/api
2. **Local**: copy `.env.example` to `.env`, set `TMDB_API_KEY=...`, restart the server.
3. **Cloudflare Pages**: add `TMDB_API_KEY` under Settings → Environment variables.

Without a key, 24/7 channels are still detected and flagged in the UI — they just won't get automatic poster art, and you can still search/link them manually. Many well-known 24/7/FAST channels (a real "Bluey" or Pluto TV channel, for instance) already resolve for free from `iptv-org`'s own catalog without needing TMDB at all — TMDB is the fallback for channels nobody's indexed.

## How matching actually works

- **Exact `tvg-id`**: if your M3U already carries a `tvg-id` that matches a known source's channel id, that's scored 1.0 and wins outright.
- **Country hints**: pulled from bracketed/prefixed/suffixed country codes or full country names in the channel name/`group-title` (e.g. `(NZ)`, `UK:`, `Sky Sports NZ`), then used to boost same-country matches and penalize cross-country name collisions.
- **24/7 detection**: a regex over `24/7`, `24-7`, `nonstop`, `marathon`, `all day`, `loop(ed)` in the name or group. Once flagged, matching switches to scoring against the *cleaned* title only (decoration stripped) — scoring against the raw name would let a channel literally named "24/7" win by substring containment against every other 24/7-flagged query, which is exactly the failure mode this avoids.
- **Confidence bar**: general matches need a score ≥0.45–0.48 depending on source; 24/7-flagged matches need ≥0.6, since a wrong identification (wrong poster, wrong logo) is worse than none.
- **Source prioritization**: a single search can't scan every EPG worker source (there are ~300, and Cloudflare's free-plan subrequest limits cap this at 40 per request) — sources are ranked by whether their host name matches the channel's country hint or name tokens before slicing to the scan limit, so a niche source is more likely to actually get checked.

## Notes

- Online discovery results are cached (disk locally, KV on Cloudflare) so requests don't need to re-probe every host or re-download the full IPTV-org API each time. If a live fetch fails, it falls back to serving the last cached copy rather than failing outright.
- `guides.json` from iptv-org is ~180k rows (~25MB) but only ~31k are actually mapped to a channel id — pruned before caching, both to stay well under Cloudflare KV's 25MB per-value limit and because the rest is dead weight either way.
- Not every internet EPG is indexable from one source, but you can paste custom guide/channel URLs in the UI and include them in matching.
- 24/7-channel placeholder guides are just that — a single all-day `<programme>` block per day with the identified title, not a real schedule.
- Progress autosaves to the browser (`localStorage`); "Save Project File" / "Load Project File" gives you a portable `.json` backup of the same state.
