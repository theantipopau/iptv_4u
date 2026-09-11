# guides/

Pre-filtered XMLTV guide snapshots, hosted here (via `raw.githubusercontent.com`) specifically because Cloudflare Workers can't reliably fetch their own domain as a subrequest — a guide hosted on this app's own `/epg/<slug>.xml` can't be used as a "custom guide URL" input for this same app on Cloudflare (self-fetch to `*.workers.dev` returns 404, and to a custom domain on the same zone times out with a 522). GitHub Pages/raw content is a genuinely separate origin, so it works fine as an input.

## nz-sky-sport.xml

All 10 Sky Sport NZ channels (Sky Sport Select, 1-9, Premier League) filtered out of [nzxmltv.github.io](https://nzxmltv.github.io)'s much larger (~57MB, all 82 Sky channels) `sky/guide.xml` — which is too large for a Cloudflare Worker to fetch+parse in one request (~128MB per-isolate memory ceiling). Real programme data, not a channel-only stub: ~5,270 programmes as of the snapshot date.

**Use it**: paste `https://raw.githubusercontent.com/theantipopau/iptv_4u/main/guides/nz-sky-sport.xml` into the "Your own EPG/guide URL(s)" field (Step 2), alongside any other guide URLs you're already using.

**This is a point-in-time snapshot, not live-refreshed** — nzxmltv's own guide updates continuously; this file doesn't. Regenerate it periodically (ask Claude to re-filter a fresh copy of `sky/guide.xml` down to channel ids 50-59 and commit it here), or point your custom-guide field at the full un-filtered `https://nzxmltv.github.io/sky/guide.xml` directly if you're running this app locally (`npm start`) instead of on Cloudflare — Node has no comparable size ceiling.
