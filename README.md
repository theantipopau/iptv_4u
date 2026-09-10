# IPTV 4U

Local web app (with a Cloudflare Pages–ready backend) to:

- Load an `.m3u` playlist — an existing XMLTV guide is optional; without one, a fresh guide is started from scratch
- Detect channels from the M3U
- Search online EPG catalogs (IPTV-org workers + API) and fetch matching **logos** (from `iptv-org/api`'s `logos.json`, or a worker guide's own `<icon>`)
- Detect 24/7 / marathon / non-stop channels by name, and (with a TMDB API key configured) identify the underlying movie/show and pull its poster art
- Link channels to EPG channel IDs, with a fast path for channels whose M3U already carries a correct `tvg-id`, and country-aware disambiguation (e.g. "Sky Sports NZ" vs. the UK feed of the same name)
- Merge selected guide data (or a synthesized placeholder schedule, for 24/7 channels with no real EPG) into your XMLTV file
- Export updated `.m3u` (with `tvg-logo` populated) and `.xml` (with `<icon>` populated)
- Autosave your session to the browser, plus explicit Save/Load of a portable project `.json` file, and a light/dark theme toggle

## Architecture

```
shared/            platform-agnostic core: parsing, matching, XMLTV building,
                    24/7 detection, TMDB lookup, EPG source discovery — no
                    fs, no Node built-ins, no Express
shared/node-cache.js   filesystem cache adapter (local/self-hosted)
functions/_lib/kv-cache.js   Cloudflare KV cache adapter
server.js           thin Express wrapper around shared/ — for `npm start`
functions/api/*.js   thin Cloudflare Pages Functions wrapper around the
                    same shared/ code — for the Cloudflare deployment
public/             static frontend, served by both backends identically
```

Both backends expose the exact same `/api/*` routes, so the frontend in `public/` doesn't know or care which one it's talking to. Fix a matching bug once in `shared/`, it's fixed on both.

## Quick Start (local)

```bash
npm install
npm start
```

Then open http://localhost:3000

## Deploying to Cloudflare Pages

The Cloudflare Functions runtime has no filesystem, so the disk cache is swapped for a Cloudflare KV namespace there (`functions/_lib/kv-cache.js`). One-time setup, all in the Cloudflare dashboard (no API token needed):

1. **Push this repo to GitHub** (or GitLab).
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**, pick this repo.
3. Build settings: **Build command** — leave blank (nothing to build). **Build output directory** — `public`.
4. **Workers & Pages → KV**: create a namespace (e.g. `iptv4u-epg-cache`).
5. On the Pages project: **Settings → Functions → KV namespace bindings** — add a binding named exactly `EPG_CACHE` pointing at that namespace.
6. **Settings → Environment variables** — add `TMDB_API_KEY` (optional, see below) as a secret.
7. Deploy. Then point `iptv4u.matthurley.dev` at the Pages project (**Custom domains** tab on the Pages project — Cloudflare manages the DNS record for you automatically since the domain's already on your account).

`wrangler.toml` is included for local testing via `npm run pages:dev` (needs a KV namespace id pasted in), but the dashboard binding above is what actually matters for the deployed site.

Note: search requests are capped to ~40 EPG sources scanned per request (`MAX_SOURCES_PER_REQUEST` in `shared/epg-service.js`) to stay under Cloudflare Workers' subrequest limits — this applies to both backends for consistency.

## Optional: 24/7 channel art via TMDB

To auto-identify 24/7 channels (e.g. a "Band of Brothers 24/7" feed) and pull poster art + a title/overview:

1. Get a free "API Key (v3 auth)" from your account settings at https://www.themoviedb.org/settings/api
2. **Local**: copy `.env.example` to `.env` and set `TMDB_API_KEY=...`, then restart the server.
3. **Cloudflare Pages**: add `TMDB_API_KEY` under Settings → Environment variables on the Pages project.

Without a key, 24/7 channels are still detected and flagged in the UI — they just won't get automatic poster art, and you can still search/link them manually. Many well-known 24/7/FAST channels (e.g. a real "Bluey" or "Pluto TV" channel) already resolve for free from `iptv-org`'s own catalog without needing TMDB at all.

## Notes

- The app attempts broad online discovery through public IPTV-org worker endpoints, and caches results (disk locally, KV on Cloudflare) so requests don't need to re-probe every host or re-download the full IPTV-org API each time. If a live fetch fails, it falls back to serving the last cached copy rather than failing outright.
- Not every internet EPG is indexable from one source, but you can paste custom guide/channel URLs in the UI and include them in matching.
- Large guide files can take time to fetch and parse.
- 24/7-channel placeholder guides are just that — a single all-day `<programme>` block per day with the identified title, not a real schedule.
