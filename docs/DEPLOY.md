# Deploy: one Worker, one command, your own domain

The site, the API and the statistics all ship as **one Cloudflare Worker**. The
HTML/JS/CSS ride along as static assets, `/token`, `/track` and `/stats` are
code, and media bytes come from B2 through the same hostname. There is no
second service to keep in sync.

```
        yourdomain.com
              │
    ┌─────────▼──────────┐
    │  Cloudflare Worker │   /            -> index.html (asset)
    │  esmeringhoy       │   /token       -> signed URL
    │                    │   /track       -> view + watch time (D1)
    │   assets + api     │   /stats       -> admin panel data
    │   + D1 database    │   /<key>?e&s   -> media from B2 (signed)
    └─────────┬──────────┘
              │  private bucket, free egress
    ┌─────────▼──────────┐
    │  Backblaze B2      │
    └────────────────────┘
```

What you need before starting: a Cloudflare account, the domain **added to that
same account** (zone active, nameservers pointing at Cloudflare), and a B2 bucket
with its key ID / application key. Bucket setup is [HOSTING.md](HOSTING.md),
statistics setup is [STATISTICS.md](STATISTICS.md) — this file is only about
getting it live on your domain.

## Part 1 — sign in

```bash
cd esmeringhoy
npx wrangler login
```

A browser tab opens at Cloudflare; clicking **Allow** is the whole
authorisation. No API token to copy, nothing to paste back. Confirm with:

```bash
npx wrangler whoami
```

## Part 2 — the statistics database

```bash
npx wrangler d1 create esh-stats
```

It prints a `database_id`. Put the four lines it suggests into `wrangler.toml`,
replacing the commented block at the bottom:

```toml
[[d1_databases]]
binding = "DB"
database_name = "esh-stats"
database_id = "paste-the-id-here"
```

The table and its indexes are created by the Worker on the first view or the
first dashboard load — there is no migration step, and running the deploy twice
changes nothing.

## Part 3 — secrets and variables

Four secrets, never in `wrangler.toml` and never in the browser:

```bash
npx wrangler secret put B2_KEY_ID           # Backblaze key ID
npx wrangler secret put B2_APPLICATION_KEY  # Backblaze application key
npx wrangler secret put MEDIA_SIGNING_KEY   # signs media URLs
npx wrangler secret put STATS_TOKEN         # password for /stats
```

`MEDIA_SIGNING_KEY` and `STATS_TOKEN` are yours to invent; long random strings
are the right answer (`openssl rand -hex 32`, `openssl rand -hex 24`). Rotating
`MEDIA_SIGNING_KEY` invalidates outstanding links; rotating `STATS_TOKEN` only
means re-entering the password in the admin panel.

`BUCKET_NAME` is not a secret — it belongs in `[vars]`, next to `SITE_ORIGINS`:

```toml
[vars]
BUCKET_NAME = "your-b2-bucket"
SITE_ORIGINS = "https://yourdomain.com,https://www.yourdomain.com"
```

`SITE_ORIGINS` is the allowlist for `/token`, `/track` and `/stats`. **Add the
exact origin you will browse the site from**, including `https://` and any
`www.` — a missing entry is the single most common cause of a player that loads
and then refuses to sign anything. `*` is accepted and means "any website may
ask me to sign media", which is not what you want.

## Part 4 — first deploy (no domain yet)

```bash
npx wrangler deploy
```

That uploads the Worker plus the site files and prints a `*.workers.dev` URL.
Open it and check the front door before touching DNS:

- `/` serves the catalog, `/admin.html` the admin panel
- `/_health` reports the bucket and whether signing is configured
- a clip plays (B2 keys and `SITE_ORIGINS` are correct)

## Part 5 — your domain

With the zone in the same Cloudflare account, add the route to `wrangler.toml`:

```toml
routes = [
  { pattern = "yourdomain.com", custom_domain = true },
  { pattern = "www.yourdomain.com", custom_domain = true }
]
```

then set `SITE_ORIGINS` to those origins and deploy again:

```bash
npx wrangler deploy
```

Cloudflare creates the DNS record for you and issues the certificate; it is
usually live in under a minute. The same thing can be done by hand under
Workers → your Worker → Settings → Domains & Routes.

If the domain is **not** in this Cloudflare account, pick one:

1. **Move the zone** — add the domain in Cloudflare, then change the nameservers
   at your registrar. This is the path that gives you the custom domain, and it
   is the usual choice; DNS propagation is the only delay.
2. **Stay where you are** — deploy to `*.workers.dev` and point a CNAME at it
   from your existing DNS. Proxy features and edge caching for the site itself
   only work through Cloudflare's own DNS, but media keeps flowing through the
   Worker either way.

## Part 6 — verify it is really working

```bash
curl -s https://yourdomain.com/_health
curl -sI https://yourdomain.com/                       # 200, text/html
curl -sI https://yourdomain.com/wrangler.toml           # 404 — config is not public
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://yourdomain.com/token?p=hls/clip/master.m3u8" -H "Origin: https://yourdomain.com"
```

The last one returning `200` with a `url` field means signing works. Then play a
clip in a browser and watch the admin panel's Statistics tab tick up — that is
the end-to-end path: page → `/token` → signed media → `/track` → D1 → `/stats`.

## What gets uploaded

`[assets] directory = "."` uploads the repo root, filtered by
[.assetsignore](../.assetsignore): `worker/`, `tools/`, `docs/`, tests, config
and dot-directories stay out. Only the 11 site files are public — verify with the
`/wrangler.toml` check above rather than by trusting the list.

`html_handling = "none"` matters for two reasons: the pages are linked by name
(`player.html?id=…`), so the default `auto-trailing-slash` would answer each one
with a 307 to the extensionless path, and a path that is not an asset has to
reach the Worker, because that is where the API lives. The Worker resolves the
two cases the asset server then misses — `/` to `index.html`, `/player` to
`player.html` — so both link styles work.

## Local development

Wrangler watches the assets directory, and its own D1/cache state lives in
`.wrangler/` *inside* it — which makes the dev server reload in a loop and stop
answering. Persist the state somewhere else:

```bash
npx wrangler dev --persist-to ../esh-state
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `D1_EXEC_ERROR: … incomplete input` | A multi-line statement sent to `DB.exec()`. D1 reads one statement per line; keep DDL single-line and use `prepare().run()`. |
| Every page answers `307` | `html_handling` reverted to the default. Set it back to `"none"`. |
| `/` answers `{"error":"bad_path"}` | The asset server missed `/` and the Worker's `index.html` fallback was removed. See "What gets uploaded". |
| `/stats` → `401` | `STATS_TOKEN` not set, or the panel's password field is empty. |
| `/stats` or `/token` → `403 origin_not_allowed` | The browsing origin is missing from `SITE_ORIGINS`. |
| Media → `403` | The link expired (reload the page for a fresh `/token`) or `MEDIA_SIGNING_KEY` was rotated. |
| Media → `502 b2_unreachable` | Wrong `B2_KEY_ID` / `B2_APPLICATION_KEY`, or the bucket name is misspelled. |
| Player shows "no video yet" | `signEndpoint` in `catalog.js` is still blank — set it to `https://yourdomain.com/token`. |

Rolling back is `npx wrangler rollback`, and `npx wrangler deployments list`
shows what is live. Deleting the Worker leaves the D1 database and its rows
alone, so an accidental teardown is recoverable.
