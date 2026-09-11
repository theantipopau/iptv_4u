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
6. **Exports** the result as downloadable files, or **publishes** it to a stable URL your player app can point at directly, optionally kept fresh automatically (see below).

The channel table supports sorting (click a column header), bulk actions (select rows → re-match or clear links together), and inline editing — click a `tvg-id` cell to type a manual override directly. A live stats bar in the header tracks how many channels have a full guide, logo-only, or no link at all as you go.

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
shared/epg-service.js     orchestration: every route's actual logic,
                         taking a pluggable cache adapter
shared/node-cache.js      filesystem cache adapter (local/self-hosted)
shared/kv-cache.js        Cloudflare KV cache adapter (same {get,
                         getStale, set} shape as the Node one)
server.js                Express app for `npm start` (local/self-hosted)
worker.js                 Cloudflare Worker entry point — one fetch
                         handler routing /api/*, /iptv/*.m3u, /epg/*.xml,
                         falling back to static assets for everything else
public/                  static frontend — identical against either backend
```

Both entry points expose the exact same routes and call the same `shared/` logic — the frontend in `public/` doesn't know or care which one it's talking to, and a matching-logic fix only needs to land in one place.

**Why two entry points, and why a single `worker.js`?** Cloudflare's "Connect to Git" flow (as of when this was built, Sep 2026) creates a unified **Worker with static assets**, not a classic Pages project — which means the old per-file `functions/api/*.js` routing convention doesn't apply here at all; it needs one `main` script declared in `wrangler.toml` that handles routing itself and falls back to `env.ASSETS.fetch()` for static files. (An earlier version of this project shipped a `functions/` directory expecting classic Pages Functions auto-detection — it silently never got wired up; static assets served fine while every `/api/*` route 404'd, since only the assets half of the deploy was actually happening. `worker.js` fixes that.) Locally, none of this matters — `server.js`/Express has no filesystem restrictions, so it just uses the disk cache directly.

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

Publishing needs somewhere to persist the files: locally that's `.hosted-files/` on disk; on Cloudflare it's the `HOSTED_FILES` KV namespace (below).

## Deploying to Cloudflare

Dashboard for the KV namespace IDs and the TMDB secret; `wrangler.toml` for everything else. No API token needs to change hands for this.

1. **Push this repo to GitHub** (or GitLab).
2. **Workers & Pages → Create → Import a repository** (or **Connect to Git**) → pick the repo. Cloudflare will build it as a **Worker with static assets**, using `worker.js` as the entry point and `public/` as the asset directory — both declared in `wrangler.toml`, so the build settings fields (build/deploy command) can stay blank.
3. **Workers & Pages → KV → Create namespace**, twice: one for the EPG cache (e.g. `iptv4u-epg-cache`), one for published files (e.g. `iptv4u-hosted-files`). Open each namespace and copy its **id**.
4. Edit `wrangler.toml` in the repo, replacing the two placeholder KV ids with the real ones from step 3, then push. (This is the one piece of "config as code" here — the Git-connected build reads bindings from this file, not from a dashboard form.)
5. On the Worker's settings: **Variables and secrets** → add `TMDB_API_KEY` (optional, see below) as a secret.
6. **Settings → Domains & Routes** → add your custom domain (e.g. `iptv4u.matthurley.dev`) — Cloudflare wires the DNS record automatically since the domain's already on your account.
7. The Cron Trigger for auto-refresh (`[triggers]` in `wrangler.toml`) should show up under **Settings → Triggers** once deployed — if it doesn't, it can also be added there directly (schedule: `0 * * * *`, i.e. hourly).

### Troubleshooting

- **Every `/api/*` route 404s, but the site itself loads fine.** This is what happens if `worker.js` isn't actually being deployed as the Worker's script — e.g. `wrangler.toml` is missing, or its `main`/`[assets]` fields got reverted. Only the static half of the deploy runs in that case, which serves `/` and `/app.js` correctly but leaves nothing to handle `/api/*`, `/iptv/*`, or `/epg/*` — that's the exact symptom that showed up in production once (see commit history) before `worker.js` existed and this project mistakenly shipped a classic-Pages-style `functions/` directory instead, which this resource type never auto-detects.
- **"Missing entry-point to Worker script" during build.** `wrangler.toml` is missing `main`, or points at a file that doesn't exist. Confirm it's set to `main = "worker.js"`.
- **KV reads/writes silently do nothing.** The `id` fields in `wrangler.toml` are still the `REPLACE_WITH_...` placeholders — swap them for the real namespace ids (step 3/4 above).

## Optional: 24/7 channel art via TMDB

1. Get a free "API Key (v3 auth)" from your account settings at https://www.themoviedb.org/settings/api
2. **Local**: copy `.env.example` to `.env`, set `TMDB_API_KEY=...`, restart the server.
3. **Cloudflare**: add `TMDB_API_KEY` under the Worker's Settings → Variables and secrets.

Without a key, 24/7 channels are still detected and flagged in the UI — they just won't get automatic poster art, and you can still search/link them manually. Many well-known 24/7/FAST channels (a real "Bluey" or Pluto TV channel, for instance) already resolve for free from `iptv-org`'s own catalog without needing TMDB at all — TMDB is the fallback for channels nobody's indexed.

## Using your own IPTV provider's EPG

Step 2 in the UI has a "Your own EPG/guide URL(s)" field — one URL per line (or comma-separated) to combine more than one. If your provider gives you an XMLTV guide URL (many do, alongside the M3U), paste it there — every one listed is fetched and matched alongside the public sources on every search/auto-match, no scan-limit applied since these are explicit sources, not part of the ~300-host public network. For a provider whose M3U already tags channels with a `tvg-id` that matches a guide's own channel `id`s (common — it's usually the same underlying dataset), this resolves real schedules for nearly every linear channel in one pass, which the sparse public worker network usually can't.

Combining more than one is genuinely useful, not just a convenience: a general-lineup guide from your own provider won't necessarily cover a country-specific channel group the way a dedicated regional guide does. For New Zealand specifically, [nzxmltv.github.io](https://nzxmltv.github.io) is a community-maintained, publicly-hosted set of XMLTV guides (Freeview, Sky, Red Bull TV, Pluto TV, ThreeNow) with real per-channel schedules including all of Sky Sport 1-9 — its `sky/guide.xml` is a solid drop-in for NZ Sky Sport channels that a general/US-focused provider guide typically won't have real listings for.

## Keeping a published playlist fresh automatically

Step 5 also has an auto-refresh section: give it an M3U **URL** (instead of just a one-off file upload) and a refresh interval, and it periodically re-fetches that URL, re-matches every channel from scratch, and re-publishes under the same slug — no need to come back and re-upload every time your provider updates the lineup.

- **Local**: use "Refresh Now" to trigger it on demand. There's no background scheduler for `npm start` — if you want it automatic locally too, point your own OS-level cron/task scheduler at `POST /api/refresh-now` with `{"slug": "..."}`.
- **Cloudflare**: a Cron Trigger (`wrangler.toml`'s `[triggers]`, fires hourly) checks every saved config and runs any that are actually due per their own interval — Cloudflare only supports fixed cron schedules, not one per user, hence the hourly tick + due-check rather than a genuinely per-config schedule.
- Channels are matched with bounded concurrency (5 at a time) and guide files are fetched once per distinct URL per run (not once per channel that happens to resolve to the same guide) — the config, and cache design generally, are built to keep this from blowing out subrequest/CPU budgets even on large lineups. Very large playlists may still want a paid Workers plan; "Refresh Now" is the way to check before relying on the schedule.

## How matching actually works

- **Exact `tvg-id`**: if your M3U already carries a `tvg-id` that matches a known source's channel id (including your own custom guide, if you've set one), that's scored 1.0 and wins outright.
- **Country hints**: pulled from bracketed/prefixed/suffixed country codes or full country names in the channel name/`group-title` (e.g. `(NZ)`, `UK:`, `Sky Sports NZ`), then used to boost same-country matches and penalize cross-country name collisions — normalized consistently on both sides (iptv-org's own data uses the literal string `"UK"` as a country value in places, not ISO `"GB"`; comparing a normalized hint against a raw candidate value was silently *penalizing* correct same-country matches until this was fixed).
- **24/7 detection**: a regex over `24/7`, `24-7`, `nonstop`, `marathon`, `all day`, `loop(ed)` in the name or group. Once flagged, matching switches to scoring against the *cleaned* title only (decoration stripped, including season/episode markers like "Season 6" or "S07") — scoring against the raw name would let a channel literally named "24/7" win by substring containment against every other 24/7-flagged query, which is exactly the failure mode this avoids.
- **Word-ratio containment, not a flat floor**: a short cleaned title only counts as "contained" in a candidate name when it's a whole word (not, e.g., "Tron" matching mid-word inside "Armstrong"), and the score is the *fraction of the longer name's words* the shorter one accounts for — not a flat "at least 0.65/0.75". A flat floor is exactly what let a channel literally named "Sport" outrank a real identification for "Stan Sport AU Event 1", or a channel named "Band" beat "Band of Brothers": one matching word out of five (or three) is a weak signal, and now scores like one.
- **Spacing-insensitive equality**: "ITV 1" and "ITV1" collapse to the same alphanumeric string and score as a near-exact match — a common enough M3U-vs-catalog naming difference (space around a trailing number) that it's worth checking for directly rather than relying on token overlap to catch it.
- **Confidence bar**: general matches need a score ≥0.45–0.48 depending on source; 24/7-flagged matches need ≥0.6, since a wrong identification (wrong poster, wrong logo) is worse than none.
- **Source prioritization**: a single search can't scan every EPG worker source (there are ~300, and Cloudflare's free-plan subrequest limits cap this at 40 per request) — sources are ranked by whether their host name matches the channel's country hint or name tokens before slicing to the scan limit, so a niche source is more likely to actually get checked.

## Notes

- Online discovery results are cached (disk locally, KV on Cloudflare) so requests don't need to re-probe every host or re-download the full IPTV-org API each time. If a live fetch fails, it falls back to serving the last cached copy rather than failing outright.
- `guides.json` from iptv-org is ~180k rows (~25MB) but only ~31k are actually mapped to a channel id — pruned before caching, both to stay well under Cloudflare KV's 25MB per-value limit and because the rest is dead weight either way.
- Not every internet EPG is indexable from one source, but you can paste custom guide/channel URLs in the UI and include them in matching.
- 24/7-channel placeholder guides are just that — a single all-day `<programme>` block per day with the identified title, not a real schedule.
- Progress autosaves to the browser (`localStorage`); "Save Project File" / "Load Project File" gives you a portable `.json` backup of the same state.
