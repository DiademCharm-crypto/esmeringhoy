# Statistics — per-clip views and watch time

The site is static, so it has no analytics backend. But every video byte already
flows through the CDN Worker in `worker/`, and that is the one place where
"someone is watching this clip right now" is a fact rather than a guess. This
document explains what gets measured, how to switch it on, and — just as
important — what the numbers can and cannot mean.

## What you get

In the admin panel, under **Statistics**:

* **Views** — playback sessions that really started playing (a bounced page is
  not a view).
* **Watch time** — forward playback only, per clip and in total, with the
  average per view and how many views finished the clip.
* **Viewers** — distinct per day, counted from a salted daily hash of the
  visitor's address. No raw IP is ever stored.
* **Daily bars**, a **per-clip table**, and a **device breakdown**. Countries
  appear when the Worker runs on Cloudflare, which supplies the country itself.
* Date ranges (today / 7 / 30 / 90 days / all time) and a single-clip filter.
* A button that copies the measured view counts into each clip's visible
  `views` field as a local edit — nothing is published until you download
  `catalog.js`.

## How it works

```
player.html ---(1) GET /token?p=...--------> Worker ---(3) B2
              <--- { url: signed }

player.html ---(2) POST /track {session, path, exp, sig, position, playing}
                        every 15s while playing, and on exit
                        |
                        v
                   D1 database (one row per session)

admin.html  ----- GET /stats?days=7 <------ aggregates over those rows
              Authorization: Bearer STATS_TOKEN
```

1. The player already exchanges each clip path for a short-lived signed URL.
2. `tracker.js` reports to `/track` beside `/token`, reusing that same
   signature as the credential — a beacon is only accepted for a path the
   Worker actually handed out, so numbers cannot be inflated without a real
   link. The body is `text/plain` on purpose: it stays a CORS "simple" request,
   and `navigator.sendBeacon` can fire it when the tab closes.
3. The Worker writes **one row per session** and updates it on each heartbeat —
   never one row per request. Segment traffic stays what it was.

The Worker derives the tracking endpoint from the sign endpoint, so pointing
`catalog.js` at the Worker configures both. There is no third-party script and
no cookie.

## Setup (about five minutes)

1. Create a database — free tier is far more than a small site needs:

   ```
   npx wrangler d1 create esh-stats
   ```

2. In the Cloudflare dashboard: your Worker → **Settings → Bindings → Add →
   D1**, variable name **`DB`**, pick the database you just created.
3. Under **Variables and Secrets**, set **`STATS_TOKEN`** to any long random
   string, e.g. `openssl rand -hex 24`.
4. Redeploy. The tables are created automatically on the first recorded view —
   there is no migration to run.

Then in the admin panel, open **Statistics**: the endpoint is derived from the
signed-URL endpoint you already configured, so you only enter the
`STATS_TOKEN`. Tick *Remember the password* if this browser is yours alone.

Optional variables:

| Variable | Default | What it does |
|---|---|---|
| `STATS_TOKEN` | — | Password for `/stats`. Never put it in `catalog.js`. |
| `TRACKING` | `on` | `off` disables all recording; beacons are still answered so the player never breaks. |
| `TRACK_REQUIRE_SIGNATURE` | on when `MEDIA_SIGNING_KEY` is set | `false` accepts unsigned beacons — only sensible for a public bucket. |
| `VIEWER_SALT` | falls back to `MEDIA_SIGNING_KEY` | Rotating this resets all unique-viewer counts. |

## How watch time is counted (the honest version)

The client reports a position; **the server decides what it is worth**. Three
rules, applied on every beacon:

1. **Forward progress only.** Seeking backwards earns nothing by itself.
2. **Nothing outruns the clock.** A report can buy at most the wall-clock
   seconds since the previous one (plus two seconds of heartbeat slack), so
   claiming "I watched an hour" one second after the last beacon is worth three
   seconds. Replaying a stretch does count again — that time was really
   watched.
3. **A session-wide backstop** caps the total at 1.5× real time plus ten
   seconds, so a long-lived tab cannot accumulate impossible totals.

What this means in practice:

* **Under-counting is the failure mode.** A phone that throttles timers in a
  background tab sends fewer heartbeats, and unsent seconds are simply not
  credited. The numbers are a floor, not a ceiling.
* **A viewer and a well-behaved script are indistinguishable.** Someone who
  reports plausible positions on a real-time cadence looks exactly like a
  viewer. No server-side measurement can tell them apart — it can only refuse
  the lazy forgeries, which is what the caps above do.
* The **`views` field in the clip editor is separate**: it is the number
  visitors see on the site, and it stays under your control. The panel's button
  copies measured counts into it when you want the two to match.

## Privacy, stated plainly

* No cookies, no localStorage on the visitor's device, no third-party script.
* The stored viewer identifier is a **salted hash of IP + the current UTC day**.
  Yesterday's hash cannot be linked to today's, and the raw address is never
  written down.
* Country comes from Cloudflare's own `request.cf`, not from a lookup service.
* **Do Not Track** and **Global Privacy Control** are honoured: those browsers
  are never reported at all.
* The admin panel's *Don't count my own views* switch stops this browser from
  reporting, so your own test plays do not skew what you are about to read.

## Cost arithmetic

One insert per viewing session, one small UPDATE per heartbeat (every 15s of
playback), and a handful of aggregate reads each time you open the panel. A
thousand finished views of a ten-minute clip is roughly 4,000 writes and
24,000 row-reads per month — inside D1's free tier by two orders of magnitude.
Statistics add **no** new Worker requests for media: `/track` is a single
beacon per heartbeat, invisible next to HLS segment traffic (see the request
budget in `docs/HOSTING.md`).

## Running it locally

The whole pipeline runs against real software on your machine — no Cloudflare
account needed for testing:

* `worker/d1-stand-in.mjs` runs the Worker's actual SQL against SQLite via
  Node's built-in `node:sqlite` (Node 22.5+).
* `node worker/b2-cdn-worker.test.mjs` drives the shipped Worker file through
  55 checks — signature-gated beacons, the watch-time caps, replay counting,
  aggregation, origin and password enforcement — against the in-repo Backblaze
  stand-in (`node tools/b2-stand-in.mjs 8090 /path/to/hls/folder`).

## Troubleshooting

| Symptom | Cause |
|---|---|
| Statistics badge says *needs the sign endpoint* | The Worker is not configured yet — set the signed-URL endpoint in the Backblaze panel first. |
| 501 `setupRequired` | `STATS_TOKEN` is unset, or no database is bound as `DB`. |
| 401 from `/stats` | The password does not match `STATS_TOKEN` exactly. |
| 403 from `/stats` | This page's origin is missing from `SITE_ORIGINS`. A `file://` admin panel sends `Origin: null`, which needs `*` or the site's own origin listed. |
| Views stay at zero | `TRACKING` is `off`, Do Not Track is enabled in that browser, or nobody pressed play — a page load alone is not a view. |
| Unique viewers read 0 | The platform is not sending a client-IP header; on Cloudflare this cannot happen. Wrangler dev and the local harness supply one. |
| The panel works locally but not deployed | Redeploy after binding `DB` — bindings only apply to new deployments. |
