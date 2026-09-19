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

The channel table supports sorting (click a column header), bulk actions (select rows → re-match or clear links together), and inline editing — click a `tvg-id` cell, or the small pencil icon on a logo, to set either one manually. A live stats bar in the header tracks how many channels have a full guide, logo-only, or no link at all as you go. The per-channel "Search" dialog always has a **"None"** option after the candidate list, whether or not any matches were found — for a 24/7 channel that's picked up the wrong show/movie, or any other confidently-wrong auto-match, this clears the link outright instead of leaving you stuck picking the least-wrong of several bad options. Anything you fix manually can be exported as a reusable **channel backlog** (see below) instead of needing the same fix again next time, and — since manual matches are captured as protected overrides at publish time — won't be silently re-guessed away by auto-refresh either (see **Keeping a published playlist fresh automatically**).

## Architecture

```
shared/                 platform-agnostic core: parsing, matching, XMLTV
                         building, 24/7 detection, TMDB lookup, EPG source
                         discovery, publishing — no fs, no Node built-ins,
                         no Express, no Cloudflare-specific APIs
shared/core.js           pure functions: M3U/XMLTV parsing & building,
                         scoreMatch, country hints, 24/7 detection
shared/validate.js        the playlist <-> guide identity contract, XMLTV
                         validity checks, guide freshness, and the
                         pre-publication quality gate — the single place
                         "is this output actually usable in a player?"
                         is decided, for serving, publishing and the
                         diagnostic script alike
shared/fetch-utils.js     fetch-with-timeout, gzip decompression
                         (Web-standard DecompressionStream — works
                         identically in Node and Workers), size-capped
                         streaming reads, concurrency
shared/epg-service.js     orchestration: every route's actual logic,
                         taking a pluggable cache adapter; including
                         validated, versioned publishing and the health
                         report
shared/serve.js           how a published playlist/guide is turned into an
                         HTTP response (status, content type, cache and
                         freshness headers, last-known-good fallback) —
                         shared so Express and Cloudflare can't diverge
shared/log.js             structured, redacting logging for both runtimes
shared/node-cache.js      filesystem cache adapter (local/self-hosted)
shared/kv-cache.js        Cloudflare KV cache adapter (same {get,
                         getStale, set} shape as the Node one; the hosted
                         store is created with no expiry)
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
                         repo for use as custom guide URLs (see below) —
                         re-generated daily by a GitHub Action, because a
                         schedule snapshot is only current for a few days
tests/                   node:test unit tests (no framework dependency) —
                         run with `npm test`
scripts/diagnose.mjs     `npm run diagnose` — compares a playlist against a
                         guide (local files or URLs), or audits every
                         published slug with `--all --base <url>`, and exits
                         non-zero if anything is invalid or disconnected
```

Both entry points expose the exact same routes and call the same `shared/` logic — the frontend in `public/` doesn't know or care which one it's talking to, and a matching-logic fix only needs to land in one place.

**Why two entry points, and why a single `worker.js`?** Cloudflare's "Connect to Git" flow (as of when this was built, Sep 2026) creates a unified **Worker with static assets**, not a classic Pages project — which means the old per-file `functions/api/*.js` routing convention doesn't apply here at all; it needs one `main` script declared in `wrangler.toml` that handles routing itself and falls back to `env.ASSETS.fetch()` for static files. Locally, none of this matters — `server.js`/Express has no filesystem restrictions, so it just uses the disk cache directly.

## Quick start (local)

```bash
npm install
npm start
```

Then open http://localhost:3000 — no XMLTV file needed to start, just an M3U.

**Tests**: `npm test` (Node's built-in `node:test`/`assert` — no test framework dependency):

- `tests/watch-core.test.mjs` — `public/watch-core.js`: M3U/XMLTV parsing, now/next selection, HTTPS-upgrade construction, URL redaction, error classification.
- `tests/alias-registry.test.mjs`, `tests/channel-overrides.test.mjs` — the curated alias registry and the protected-override storage contract.
- `tests/epg-integrity.test.mjs` — the identifier contract, the publication gate, and the regression tests for the "playlist loads, guide shows nothing" outage (including a guide that was healthy when published and is read again after it ages out).
- `tests/hosted-storage.test.mjs` — cache adapters, versioned publication, read-after-write verification, rollback and backwards compatibility with pre-manifest publications.
- `tests/routes.test.mjs` — the real Express app: content types, status codes, `HEAD`, ETag/cache headers, health endpoint and last-known-good fallback.

These are unit and route-level tests, not a browser automation suite — playback itself is verified manually against real streams (see **Watching in the browser**). Everything in `tests/fixtures.mjs` is synthetic: no real provider playlist, stream URL or credential is committed.

## Diagnosing from the command line

```bash
# Compare what's actually being served (local files also work):
npm run diagnose -- --slug my-slug --base https://iptv.example.com
npm run diagnose -- --playlist ./playlist.m3u --epg ./guide.xml
npm run diagnose -- --slug my-slug --base https://iptv.example.com --json

# Audit every published slug on a running instance (the "I already have
# guides published" check — no need to know the slugs in advance):
npm run diagnose -- --all --base https://iptv.example.com
```

`--all` is the migration check. It lists every published slug with its status,
expiry countdown, current/future programme count and refresh state, sorted worst
first, reports how many have expired / expire soon / have no auto-refresh / are
not being run, and exits non-zero when any guide is expired, invalid or
unpublished. Running it once against an existing deployment is how you find the
slugs that were published before any of this existed:

It reports playlist/guide counts, identifier coverage, the programme date range
and freshness, lists every error and warning, and **exits non-zero** if the pair
is structurally invalid or disconnected. Output is counts and identifiers only —
never a stream URL or the playlist body. `--now <ISO>` checks a guide as of a
specific time (used by the tests to simulate a guide ageing out).

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
| `POST /api/publish` | `{ slug, m3uContent?, xmlContent?, overrides? }` (at least one content field) — `overrides` is `{ [channelName]: link }` for every currently-manual link; see **Keeping a published playlist fresh automatically** | `{ ok, slug }` — then served at `/iptv/<slug>.m3u` and/or `/epg/<slug>.xml` |
| `POST /api/refresh-config` | `{ slug, m3uUrl, customGuideUrl?, intervalKey? }` (`intervalKey`: `"6h"`, `"12h"`, `"24h"`, or `null`/omitted for off) | `{ ok, config }` |
| `GET /api/refresh-config/:slug` | — | `{ ok, config }` (`config: null` if nothing saved for that slug) |
| `POST /api/refresh-now` | `{ slug }` | Runs the saved config's fetch→match→publish pipeline immediately. `{ ok, config }`, updated with `lastRunAt`/`lastRunStatus`/`lastRunChannelCount`/etc. |
| `GET /iptv/:slug.m3u` | — | The published playlist. `audio/x-mpegurl; charset=utf-8`, `ETag`, 5-minute revalidating cache. `404` + JSON (`code: "PLAYLIST_NOT_FOUND"`) if nothing's been published under that slug. |
| `GET /epg/:slug.xml` | — | The published guide. `application/xml; charset=utf-8`, `ETag`, plus `X-EPG-Freshness` (`fresh`/`ending-soon`/`expired`/`no-programmes`), `X-EPG-Latest-Stop`, `X-Hosted-Version`. `404` + JSON (`code: "EPG_NOT_FOUND"`) if missing; `503` + JSON if the stored guide is corrupt and no last-known-good version exists. `HEAD` is supported on both content routes. |
| `GET /api/health/epg/:slug` | — | `{ ok, status, slug, published, playlist, epg, mapping, storage, warnings, checkedAt }`. `status` is one of `healthy`, `degraded`, `stale`, `invalid`, `missing`. Diagnostic metadata only — never a stream URL, playlist body or credential. This is the endpoint to check first when a player shows no guide. |
| `GET /api/health/epg` | — | `{ ok, status, count, attention, scheduler, slugs, warnings, checkedAt }` — every published slug with its guide age, expiry countdown (`expiry.inMs` / `expiry.expired`), live current/future programme count, renewal state (`renewal`: `auto` \| `will-expire` \| `paused` \| `overdue`), and refresh detail (`refresh.lastRunAt` / `nextRunAt` / `lastRunStatus`). Rows are sorted worst-first by `attentionRank` (expired, then expiring soon, then unrenewed, then healthy). `attention` counts what is broken; `scheduler` says whether anything is actually executing enabled configs. This is what the UI's **Published guides & freshness** table renders, and the one call that answers "is any of my guides about to expire?". |

Every remote fetch (a custom guide URL, an auto-refresh's M3U source, a worker's channel list) is capped at 15MB, checked both via `Content-Length` and while streaming — see **Notes** for why, and **`guides/`** below for the workaround when a source you want is larger than that.

API errors are structured, not generic: `{ ok: false, error, code, details? }`, where `code` names the stage that failed (`PUBLISH_VALIDATION_FAILED`, `PUBLISH_STORAGE_WRITE_FAILED`, `PUBLISH_READBACK_FAILED`, `EPG_NOT_FOUND`, `STORAGE_BINDING_MISSING`, `REFRESH_CONFIG_NOT_FOUND`, `GUIDE_CHANNEL_NOT_FOUND`, ...). For a blocked publish, `details.errors` lists every reason.

## Publishing to a stable URL (TiViMate, etc.)

Downloading updated files works, but re-uploading them into a player app every time you re-run a match is tedious. Step 5 in the UI ("Publish") instead saves the final M3U/XML to the server under a slug you choose and gives you back two stable URLs:

```
https://iptv4u.matthurley.dev/iptv/yourplaylist.m3u
https://iptv4u.matthurley.dev/epg/yourepg.xml
```

Point TiViMate (or any player that takes a playlist/EPG URL) at those, and re-publishing later updates the same URLs in place — no need to touch the player app again.

The slug is remembered across sessions (autosave, and a saved/loaded project file both carry it) as soon as you set it — you don't need to actually click Publish first, just entering it and clicking elsewhere is enough. Resuming a previous session then shows these URLs and the "Watch Live in Browser" link immediately, without needing to re-publish just to see them again. They're deterministic from the slug alone, so this is just redisplaying known information, not implying anything's been freshly re-published — if you've changed the playlist since the last publish, hit Publish again to actually push the update. (A session saved before this behavior existed won't have a slug to restore — just re-enter it once and it'll carry forward from then on.)

> **These URLs are public and unauthenticated.** Anyone who knows the exact slug can fetch your playlist and channel stream URLs. Pick a slug that isn't trivially guessable if your provider embeds private access tokens in the stream URLs (many IPTV services do) — treat the link like a password, not a username.

Publishing needs somewhere to persist the files: locally that's `.hosted-files/` on disk; on Cloudflare it's the `HOSTED_FILES` KV namespace (below).

### TiViMate setup (and refreshing it)

1. Playlist → **Add playlist → Remote playlist**, URL `https://<your-host>/iptv/<slug>.m3u`.
2. EPG → **Add EPG → Remote EPG**, URL `https://<your-host>/epg/<slug>.xml` (TiViMate accepts `application/xml`).
3. Let it import, then open the guide.

TiViMate caches what it downloads. When a guide has been fixed or republished,
**refresh the EPG in TiViMate** (Settings → EPG → update) — but only *after*
the server-side checks (see the troubleshooting section below) are green.
Removing and re-adding the guide is a last resort for a player-side cache, not a
diagnosis.

### What a publish actually checks

A publication is validated before anything is stored, and verified after it's
stored. Both files are checked together, because **both files can be
individually perfect and still leave a player showing no guide at all** — that
is the failure mode below.

Blocked outright (nothing is written, the previous version stays live):

- an empty or channel-less playlist, or a playlist where no channel has a `tvg-id`
- a guide that isn't parseable, isn't XMLTV, has no `<channel>` entries, or is an
  HTML/JSON error document served with `200`
- **a guide whose every programme has already ended** — valid XML, useless schedule
- **no `tvg-id` / `<channel id>` overlap at all** between the two files
- a guide with channels but no programmes, when a guide with programmes is
  currently published
- programme data was expected (guide-backed channels were matched) but none is present
- a write that doesn't read back byte-identical

Published with warnings (visible in the UI and in `/api/health/epg/<slug>`):

- partial coverage, unmatched channels, duplicate or blank `tvg-id` values
- a guide whose schedule runs out within 12 hours
- programme count falling by more than half against the previous publication
- any programme referencing a channel id the guide doesn't declare (beyond a small tolerance)

### How a publication is stored

```
hosted:<slug>:versions:<version>:playlist   validated candidate
hosted:<slug>:versions:<version>:epg        validated candidate
hosted:<slug>:manifest                      the switch that promotes a pair
hosted:<slug>:m3u, hosted:<slug>:xml        compatibility keys the routes fall back to
```

The candidate pair is written and read back first; only then is the manifest
updated, and only then are the compatibility keys. Reading resolves *through*
the manifest, so the playlist and the guide a player receives always come from
the same publication — Cloudflare KV has no multi-key transaction, and this is
the closest safe equivalent. The previous version is kept (`previousVersion`),
which is what lets the routes serve a last-known-good guide if the live one is
found to be corrupt, and what makes a manual rollback possible (see
**Rolling back** below).

Publishing a playlist and a guide under one slug in a *single* request keeps
them in step. Publishing only one of the two still works (the other is left
alone, exactly as before).

> **Upgrading an existing deployment:** published KV values written before
> versioned publishing inherit a 30-day expiry (the cache's TTL used to apply to
> published files too — a bug, since a player's URL should never expire). Those
> TTLs stay in effect until the key is rewritten, so **republish each slug once**
> (or hit **Refresh Now**) after deploying. Until then, a long-unpublished slug
> can still expire and start returning `404 EPG_NOT_FOUND` instead of a guide.

### Rolling back to a previous version

Every publish records its predecessor in the manifest. To serve an earlier
version, read the manifest and repoint `activeVersion` at the version you want:

```bash
# Local (files live in .hosted-files/):
cat .hosted-files/hosted_<slug>_manifest.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data))"
# Then republish the pair you want with the UI/API — the simplest reliable rollback
# is to re-run a publish, which re-validates and re-promotes a known-good pair.
```

On Cloudflare, the same keys are visible under **Workers & Pages → KV →
`iptv4u-hosted-files`**, where `hosted:<slug>:manifest` names the active version
and `...:versions:<version>:playlist|epg` hold that version's content. Setting
`activeVersion` to a previous value switches both files back together.

## Troubleshooting: channels load, but the guide shows no EPG for any channel

Work through this server-side first. A player showing no EPG for **every**
channel is almost always the published guide, not the player app — resetting or
re-adding the guide in TiViMate cannot fix a guide that has expired or come
disconnected.

1. **Check the playlist still serves:** `curl -sI https://<your-host>/iptv/<slug>.m3u` — expect `200` and `audio/x-mpegurl; charset=utf-8`.
2. **Check the guide still serves:** `curl -sI https://<your-host>/epg/<slug>.xml` — expect `200` and `application/xml; charset=utf-8`. A `404` means nothing is published under that slug; a `503` means the stored guide is corrupt.
3. **Confirm the body is XMLTV, not an error page:** `curl -s https://<your-host>/epg/<slug>.xml | head -c 200` should start with `<?xml version="1.0" encoding="UTF-8"?>` and contain `<tv`. `200 OK` with HTML or JSON in it is a failure, not a success.
4. **Check the guide contains programmes that haven't ended** — the step that catches this exact outage. The `X-EPG-Freshness` header on the response says it directly, and `npm run diagnose` prints the range:
   ```bash
   npm run diagnose -- --slug <slug> --base https://<your-host>
   ```
   `freshness: expired` with `current/future: 0` means every programme has finished: the playlist will load in TiViMate and the guide will be completely empty.
5. **Compare the identifiers:** the same command reports `matched ids` and coverage. `0` matched ids means the M3U `tvg-id` values and the guide's `<channel id>` values no longer line up — players join the two by exact string equality.
6. **Ask the server what it thinks:** `curl -s https://<your-host>/api/health/epg/<slug>` returns `healthy`, `degraded`, `stale`, `invalid` or `missing`, with counts, coverage, freshness, the active version and warnings. The UI's **EPG health → Test Published Files** shows the same report.
7. **Check the active published version and when it was published** (`storage.activeVersion` / `storage.publishedAt` in that report, or the manifest). A guide published days ago with no auto-refresh is the expected way this happens.
8. **Only once the server checks pass**, republish (the UI blocks a publish that would leave you in this state) or trigger **Refresh Now**. If guide sources themselves have gone stale, refresh those first — see **`guides/`**.
9. **Then refresh the EPG in TiViMate.** Removing and re-adding the guide is a last resort for a player-side cache, not a first step — and it will not help if steps 1-8 aren't green.

### Why a guide can go stale even though everything is "working"

XMLTV is a *schedule*, not a description of a channel: a guide downloaded from
any source only covers a few days (or weeks for some sources) ahead. Once its
last programme ends, the file is still valid XML, still serves `200`, still has
`<channel>` nodes — and shows nothing in every player:

- Channels matched against one of the `guides/*.xml` snapshots only have schedule data for as long as that snapshot covers (re-generated daily by the GitHub Action, but a *published* guide is a frozen copy of whatever was current when you published it).
- 24/7 channels get synthesized placeholder programmes for 3 days from the moment of publishing.
- Nothing re-publishes automatically unless you've saved an auto-refresh config for that slug — **and publishing does not create one.** Enrolment is a separate, deliberate step (see below).

So: for any slug you point a player at, configure **Keep it fresh automatically**
(M3U source URL + interval), and check **EPG health** after each publish. The
pre-publication gate refuses to publish an all-expired guide, so the failure
mode from here on is a guide that ages out *after* it was published — which the
health endpoint reports as `stale` and which auto-refresh prevents.

**Publishing and auto-refresh are two separate actions, on purpose but not by accident.** Publishing is a one-shot write of a playlist + guide pair. Auto-refresh is a standing instruction to redo that write on a schedule, which needs a *source* (an M3U URL) that a one-off file upload doesn't have — so it cannot be inferred at publish time. The consequence is that a published slug with no auto-refresh config is a perfectly normal, healthy-looking, working guide that will stop working on its own in a few days.

That used to be an easy thing to miss, so it is now stated at every point where it could be missed:

**Immediately after Publish**, in the Publish panel itself:

```text
✅ Published
✅ Playlist healthy — 254 channels
✅ Guide healthy — 223 channels, 16121 programmes (8400 current or upcoming)
• Guide expires in: 3.0 days
⚠ No auto-refresh configured — this slug is marked WILL EXPIRE
[ Enable Auto Refresh Now ]
⚠ This guide appears healthy but will eventually expire unless auto-refresh is enabled.
```

That is also the server's own message: `POST /api/publish` returns a
`GUIDE_WILL_EXPIRE_WITHOUT_REFRESH` warning (with the expiry time) for any
publication whose guide has current programmes and no renewal schedule. It is a
warning rather than an error because the files really are fine — they simply
will not stay fine. **Enable Auto Refresh Now** enrols the slug using the M3U
source URL from the **Keep it fresh automatically** panel; if that field is
still empty it focuses it and says what to paste, rather than sending you off to
read anything.

**On every load**, in a standing banner above the Publish panel: how many
published guides have expired, are expiring within 12 hours, have no
auto-refresh, or have auto-refresh enabled but nothing running it. This is the
migration path for slugs published before any of this existed — they are found
by auditing the store, not by you remembering them.

**In the dashboard**, described below, where every slug carries its own countdown
and `No — will expire` label.

### Surfacing the Cloudflare Cron Trigger

A missing Cron Trigger is the one failure that makes every slug look correct:
configs saved, intervals set, guides valid, `refresh.enabled: true` — and
nothing ever executing. Three things make it visible instead:

- `/api/health/epg` → `scheduler`: `{ enabledConfigs, neverRun, overdue, lastRunAt, observed }`, where `observed` is `true` (something is running), `false` (enabled but not being executed), or `null` (no enabled configs, or enabled too recently to say).
- `AUTO_REFRESH_OVERDUE` per slug, plus `SCHEDULER_NOT_OBSERVED` globally, both naming the likely fix (`Settings → Trigger events`, schedule `0 * * * *`).
- The dashboard's `Auto-refresh scheduler: running / NOT OBSERVED` line, and `Enabled — but not running` in the auto-refresh column.

"Overdue" is measured, not guessed: a run that is *attempted* — successfully or
not — always advances `lastRunAt`, so a config that is past its interval plus a
two-hour grace period without `lastRunAt` moving has not been executed. A config
enabled moments ago is deliberately reported as `null`/no claim rather than as a
failure, and a stray `lastRunAt` from a manual **Refresh Now** is not enough to
call the scheduler healthy (which is why `overdue` overrides it).

### "Why isn't my guide refreshing?" — check in this order

A guide whose schedule has run out is indistinguishable from a guide that was
never enrolled, from the player's point of view. Both are visible server-side:

0. **Ask once, for every slug:** `npm run diagnose -- --all --base https://<your-host>`. It prints a worst-first table of every published slug with its expiry countdown and refresh state, and exits non-zero if anything has expired.
1. **Is there a config at all?** `curl -s https://<your-host>/api/refresh-config/<slug>` → `config: null` means no auto-refresh was ever saved for that slug. That is the whole answer: nothing was going to renew it, and no code path creates a config implicitly (see the two conditions above). It has not been "lost" — nothing in either storage adapter deletes a config, and both stores are written with no expiry, so a config that was saved stays saved.
2. **Is the interval actually set?** A config can exist with `intervalKey: null` (the interval selector left on **Off**). It is stored, it reads back, and it will never run — `config.intervalKey === null` means exactly that.
3. **Did the scheduler run at all?** `/api/health/epg` reports `refresh.lastRunAt` / `refresh.nextRunAt` / `refresh.lastRunStatus` per slug. `lastRunAt: null` with an interval set means it is due but nothing has executed yet — check the Cloudflare Cron Trigger exists under **Settings → Trigger events** (`0 * * * *`), or that `IPTV4U_NO_SCHEDULER` isn't set locally.
4. **Did a run fail?** `lastRunStatus: "error"` with `lastRunErrorCode` — a failing run is *reported*, not silent, and deliberately leaves the previous guide live. `PUBLISH_VALIDATION_FAILED` on a refresh means the sources themselves only had expired programmes, so the old guide was kept rather than replaced with a worse one.
5. **Is it simply out of schedule?** `/api/health/epg` gives `freshness` and `scheduleRemainingMs` per slug; `expired` means its last programme has passed. Republish (or **Refresh Now**) once the sources are current again.

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

Step 5 also has an auto-refresh section: give it an M3U **URL** (instead of just a one-off file upload) and a refresh interval, and it periodically re-fetches that URL, re-matches every channel, and re-publishes under the same slug — no need to come back and re-upload every time your provider updates the lineup.

**Two things have to both be true, and the UI now says which one isn't:**

1. **A config exists for the slug.** Saved by **Save Auto-Refresh Config** (or `POST /api/refresh-config`) and nothing else. Publishing a playlist does *not* create one, and no code path creates one implicitly, so `GET /api/refresh-config/<slug>` returning `config: null` means this step was never done for that slug — the guide has no way to renew itself.
2. **That config has an interval of `6h`/`12h`/`24h`.** A config saved with the interval selector on **Off** is stored, reads back fine, and is *never due* — it will not run, ever. The interval selector defaults to **Daily** for this reason; if you deliberately pick Off, the UI tells you it will still expire, and `/api/health/epg` reports it as `AUTO_REFRESH_PAUSED` rather than as enabled.

- **Local / self-hosted**: `npm start` runs an in-process scheduler (hourly by default: `IPTV4U_REFRESH_TICK_MS`, disable with `IPTV4U_NO_SCHEDULER=1`) that checks every saved config for whether it's due, using the same code path as the Worker. **Refresh Now** triggers one immediately on demand.
- **Cloudflare**: a Cron Trigger (`wrangler.toml`'s `[triggers]`, fires hourly) checks every saved config and runs any that are actually due per their own interval — Cloudflare only supports fixed cron schedules, not one per user, hence the hourly tick + due-check rather than a genuinely per-config schedule.
- **A config and its slug's published files are both stored with no expiry.** They are the only thing standing between a working guide and silent expiry, so they must not disappear on their own (they previously inherited the 30-day cache TTL, which made auto-refresh self-defeating: the config would expire, the guide would stop being renewed, and then the guide would expire too).
- **Check it actually ran**: the status line under the buttons shows the last run, and the **Published guides & freshness** table shows last run, next run and status per slug, so a saved-but-never-executed config is visible instead of implied.

### How a guide can still expire despite auto-refresh

Auto-refresh removes the *automatic* expiry, not every way to lose EPG data. What is left is reported explicitly rather than left to be discovered in a player:

| What happened | What you see |
|---|---|
| A run was due and never executed (missing Cron Trigger, `IPTV4U_NO_SCHEDULER=1`, a scheduler that died) | `AUTO_REFRESH_OVERDUE` per slug, `SCHEDULER_NOT_OBSERVED` when nothing has ever run, `Enabled — but not running` in the dashboard |
| A run executed and failed to publish (sources only had expired programmes, upstream 5xx, a guide URL that stopped being XML) | `AUTO_REFRESH_FAILING` with the recorded `lastRunErrorCode`; the previous guide stays live on purpose |
| The config exists but its interval is Off | `AUTO_REFRESH_PAUSED`, `Saved but Off — will expire` |
| Nothing renews it at all | `NO_AUTO_REFRESH`, `No — will expire`, and the publish-time warning above |
| Upstream sources themselves stopped carrying real schedules | the guide stops changing; freshness/`currentOrFuture` still reports it, and `npm run diagnose -- --playlist ... --epg ...` shows whether the data or the matching is at fault |

The last case is worth internalising: a guide built from one of the `guides/*.xml` snapshots only ever contains what that snapshot covered. Auto-refresh re-reads the *source*, so if the source is stale, so is the republished guide.
- Channels are matched with bounded concurrency (5 at a time) and guide files are fetched once per distinct URL per run (not once per channel that happens to resolve to the same guide) — the config, and cache design generally, are built to keep this from blowing out subrequest/CPU budgets even on large lineups. Very large playlists may still want a paid Workers plan; "Refresh Now" is the way to check before relying on the schedule.

**Manual fixes are protected, not re-guessed every run.** Every channel you've manually corrected (an inline `tvg-id` edit, an uploaded logo — anything showing as `(manual)` in the table) is captured as a *channel override* the moment you hit Publish, keyed by the channel's exact M3U name, and stored alongside the published files. Auto-refresh checks this list before matching each channel — if there's an override for it, that's used as-is and the channel is never re-searched, so it can't be silently replaced by a worse (or just different) automatic match on the next scheduled run. The status line under auto-refresh shows how many overrides were applied on the last run (`... , 3 manual overrides preserved`). Overrides are re-captured on every Publish — if you clear a manual fix (e.g. by re-running auto-match over it) and publish again, it stops being protected too, since Publish always saves the *current* set of manual links, not an accumulating history.

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

### Connection-limit awareness

Most IPTV plans allow only 1-2 simultaneous connections, and it's easy to accidentally burn through them without realizing — a backgrounded tab left playing, or a second tab open to the same slug. Three mitigations, all client-side (no server involved, since the app has no way to see or control your provider's own connection count):

- **A "Stop" button** in the player toolbar — explicitly tears down the current stream and releases the connection, rather than needing to select another channel or close the tab.
- **Auto-release when backgrounded**: if the tab sits hidden for 3 minutes while still playing, playback stops on its own with a "tap to resume" prompt — this is exactly the "frozen player keeps a slot busy without your knowledge" failure mode some providers warn about.
- **Same-browser cross-tab warning**: if you open `/watch` in a second tab of the *same browser* while another tab is already streaming, a banner names which channel and warns that starting playback here uses a second connection. This uses `BroadcastChannel` to coordinate between tabs — it can only see other tabs of this same browser, never another device or a different browser, so it's a partial safety net, not a real connection-count guarantee.

### Installable as a PWA

`manifest.webmanifest` + `service-worker.js` make `/watch` installable on a phone's home screen. The service worker caches the static shell only (HTML/CSS/JS/icons) — it has an explicit **deny-first** rule for anything playlist-, guide-, or stream-related (`/iptv/*`, `/epg/*`, `/api/*`, any response whose `Content-Type` looks like media/manifest data) that always goes straight to the network, never into the cache, regardless of path. Shell assets themselves are served **network-first**: while online you always get the current deployed code, and the cache is only a fallback when the network request fails — offline, the shell still loads with a clear "live channels need a network connection" banner rather than pretending to play anything without one.

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

## The identifier contract (why matching and publishing must agree)

A player joins a playlist entry to its programmes by **exact string equality**:

```text
M3U  tvg-id="espn.us"
==   XMLTV <channel id="espn.us">
==   XMLTV <programme channel="espn.us">
```

No fuzzy matching, no normalisation, no case-insensitivity. So the two files are
built from one shared value — the id of the matched channel — and the
merge step only ever adds a `<channel>` node whose id is *exactly* the id being
written into the M3U. Two rules follow from that, both enforced in code and
covered by tests:

- A guide channel is only used when its id matches the requested id. A
  name-based fallback that resolves to a *different* id is refused (the channel
  is reported as unmatched instead), because that is precisely how the two files
  silently drift apart.
- A guide that carries programmes for an id but no `<channel>` node for it is
  still usable: the node is synthesised **for that same id**.

The pre-publication gate then checks the contract across the whole file pair
(`IDENTIFIERS_DISCONNECTED`, `IDENTIFIERS_WITHOUT_PROGRAMMES`), and
`/api/health/epg/:slug` reports the same numbers after the fact.

## Notes

- Online discovery results are cached (disk locally, KV on Cloudflare) so requests don't need to re-probe every host or re-download the full IPTV-org API each time. If a live fetch fails, it falls back to serving the last cached copy rather than failing outright. Source-cache entries expire on a freshness window but are readable for 30 days after that, so a stale-but-valid copy can still be served when a live fetch fails — published files, by contrast, never expire on their own.
- XMLTV is serialised with characters XML 1.0 forbids (raw control characters from a provider's own metadata) stripped out, so one bad channel name can't make the whole guide unparseable. Timestamps are always UTC-formatted (`YYYYMMDDHHMMSS +0000`) and parsed back with their offset honoured — no locale-dependent date formatting anywhere in the generated files.
- Request/response logging is structured JSON with URLs reduced to `scheme://host/<redacted>` and fields like `url`, `token`, `content` dropped entirely; the health endpoint returns counts and identifiers only.
- **Not implemented, and worth knowing:** there is no rate limiting on the CPU-heavy endpoints, no authentication on `/api/*` or the published URLs (by design for a self-hosted tool — see the privacy warning above), and custom guide URLs / the auto-refresh M3U URL are user-supplied and fetched as-is, so an SSRF allow-list would break the feature. Treat this as a single-user tool on a trusted network, not a multi-tenant service.
- `guides.json` from iptv-org is ~180k rows (~25MB) but only ~31k are actually mapped to a channel id — pruned before caching, both to stay well under Cloudflare KV's 25MB per-value limit and because the rest is dead weight either way.
- **Every remote fetch (custom guide URLs, worker channel lists, auto-refresh's M3U source) is capped at 15MB.** Cloudflare Workers have a ~128MB per-isolate memory ceiling, and a large XMLTV guide parses into an in-memory object graph several times the size of its raw bytes — a 50MB+ guide crashes the whole Worker invocation outright (an opaque Cloudflare "error 1102") rather than just failing the one request that triggered it. The cap is enforced identically on both platforms (Node has far more headroom and would handle a bigger file fine, but a consistent, predictable limit beats one that silently depends on which backend happens to be running). If a source you want is larger, filter it down first — see `guides/README.md` for how this was done for the NZ Sky Sport guide.
- Not every internet EPG is indexable from one source, but you can add custom guide/channel URLs in the UI and include them in matching — see **Using your own IPTV provider's EPG** above.
- 24/7-channel placeholder guides are just that — a single all-day `<programme>` block per day with the identified title, not a real schedule.
- Progress autosaves to the browser (`localStorage`); "Save Project File" / "Load Project File" gives you a portable `.json` backup of the same state.
