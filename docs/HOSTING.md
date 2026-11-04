# Hosting: Backblaze B2, browser uploads, and the signed-URL CDN

This is the whole delivery path: video lives in a **private** B2 bucket, a
**Cloudflare Worker** signs and serves it, and the admin panel uploads straight
to B2 from the browser. The catalog itself publishes through the Worker's D1
database, so admin changes reach every visitor without replacing a file.

```
                        ┌──────────────────────────────┐
   admin.html  ──PUT──►  │  Backblaze B2 (private)      │
   (presigned URL)       │  your-bucket                 │
                        └──────────────┬───────────────┘
                                       │ B2 → Cloudflare is free
                                       │ (Bandwidth Alliance)
                        ┌──────────────▼───────────────┐
   player.html ──GET──►  │  Cloudflare Worker           │
   /token then media     │  verifies signature, signs   │
                        │  upstream, caches at the edge│
                        └──────────────────────────────┘
```

Why a Worker rather than pointing the site at B2 directly: a private bucket
cannot be read by a browser at all, and a public one can be downloaded by
anyone who finds the URL. The Worker is the piece that decides who gets bytes.

---

## Part 1 — the bucket

1. B2 console → **Buckets** → *Create a Bucket*. Keep it **Private**.
2. Under **Bucket Settings** set **Bucket Info** to `{"Cache-Control":"public, max-age=86400"}`.
   Cloudflare will not cache without it.
3. Under **Bucket Details**, copy two things you will need:
   - the **S3 endpoint**, e.g. `https://s3.us-west-004.backblazeb2.com`
   - its **region** segment, e.g. `us-west-004`
4. **Buckets → App Keys → Add a New Application Key**
   - Access: **Read and Write**
   - Allow access to: *just this bucket* (not all)
   - Copy the **keyID** and the **applicationKey** — the key is shown once.

A key scoped to one bucket is the right key for day-to-day use: it cannot touch
anything else in your account.

## Part 2 — allow browser uploads (once)

A browser may only `PUT` to B2 if the bucket's CORS rules say so, and B2 denies
every preflight by default. This cannot be done from a web page — B2 refuses
CORS for its account-level APIs — so run it here, once:

```bash
B2_KEY_ID=your-master-key-id \
B2_APPLICATION_KEY=your-master-key \
B2_BUCKET=your-bucket \
B2_REGION=us-west-004 \
  node tools/b2-setup.mjs
```

It authorizes with B2, enables the S3-compatible API on the bucket if needed,
and adds CORS rules for `s3_put` (uploads) plus, with `--allow-download`,
`s3_get`/`s3_head` (browser downloads). Add `--dry-run` to see the change first
and `--origins https://admin.example.com` to restrict who may upload.

> Use your **master** application key for this step. Updating bucket settings
> needs the `writeBuckets` capability, which a read/write key scoped to one
> bucket does not have. The scoped key is what you paste into the admin panel.

## Part 3 — upload from the admin panel

Open `admin.html`, expand **Backblaze connection**, and fill in:

| Field | Value |
|---|---|
| Playback base URL | your public B2 URL now, the Worker URL later |
| Signed-URL endpoint | blank for a public bucket; `https://media.example.com/token` for the private setup |
| S3 endpoint | from Bucket Details, e.g. `https://s3.us-west-004.backblazeb2.com` |
| Bucket | your bucket name |
| Key ID / Application key | the scoped key from Part 1 |
| Upload path prefix | `clips` (files land at `clips/<name>.mp4`) |

**Save connection**, then **+ Add clip** → drag a video in → **Upload to
Backblaze**. The upload is signed in the page (`signv4.js`) and `PUT` straight to
B2, with live progress. When it finishes the panel fills in the **Video URL**
automatically, probes the file for its real duration, and grabs a thumbnail
frame from the video and uploads it as `<name>-poster.jpg` — so the site's
thumbnail is a frame from the film rather than a generated placeholder.

Then click **Publish live**. The catalog is written to the Worker's D1 database
and served at `/catalog.js`, so every visitor gets it on their next page load
without another deploy. Copy/Download remain as an offline backup. A clip you
save is visible in your browser immediately; it is not visible to visitors until
you publish. The line under *How publishing works* re-reads the deployed
`catalog.js`: green **Published** means visitors see exactly what you see, and a
**Not published** warning names the clips they cannot see yet.

This requires opening the admin panel on the deployed Worker/domain. GitHub
Pages alone is static and cannot accept live publishes — use the Cloudflare
address, not a `github.io` address.

**What the panel knows about your key.** It is used in memory for that tab unless
you tick *Remember*, in which case it is stored unencrypted in this browser only.
Nothing is sent anywhere except to Backblaze. Keep `admin.html` off the public
internet — it has no login.

For a whole HLS ladder, use `tools/b2-upload.mjs` instead:
see [VIDEO-PIPELINE.md](VIDEO-PIPELINE.md).

## Part 4 — the Cloudflare Worker (free egress, signed URLs)

Backblaze does not bill for egress to Cloudflare, and Cloudflare does not bill
for egress to visitors, which is what makes this combination free at any volume.

This part walks through the dashboard. To put the same Worker, the site files and
the statistics database live on your own domain from the command line, follow
[DEPLOY.md](DEPLOY.md) instead — the two describe the same Worker.

1. Cloudflare dashboard → **Workers & Pages** → *Create* → *Worker*. Name it
   something like `esh-media`.
2. Replace the starter code with the entire contents of
   [`worker/b2-cdn-worker.js`](../worker/b2-cdn-worker.js).
3. **Settings → Variables and Secrets**, add:

| Name | Value | Type |
|---|---|---|
| `BUCKET_NAME` | your bucket | Text |
| `B2_KEY_ID` | the **read-only or read/write scoped** key id | Text |
| `B2_APPLICATION_KEY` | that key | **Secret** |
| `MEDIA_SIGNING_KEY` | any long random string (e.g. 40+ random chars) | **Secret** |
| `SITE_ORIGINS` | `https://your-site.com` (comma-separate several) | Text |
| `TOKEN_TTL` | `21600` (6 hours) | Text, optional |
| `CACHE_TTL` | `86400` | Text, optional |

4. Deploy, then open `https://<worker>/_health`. It should report
   `{"ok":true,"signing":true,…}`.
5. Visit `https://<worker>/<a-real-key>?e=1&s=x` — it must answer **403**. An
   unsigned request never reaching the bucket is the whole point; confirm it.
6. In the admin panel set:
   - **Playback base URL** → the Worker's URL, e.g. `https://esh-media.you.workers.dev`
   - **Signed-URL endpoint** → the same URL plus `/token`
   - **Save connection**, then **Publish live**.
7. Add the Worker to a custom domain in Cloudflare (Workers → your Worker →
   *Settings → Domains & Routes*), e.g. `media.your-site.com`, and use that as the
   base URL. `*.workers.dev` works fine too.

### How the site gets signed URLs

`catalog.js` carries both settings:

```js
window.ESMERINGHOY_MEDIA = {
  b2BaseUrl: "https://media.your-site.com",
  signEndpoint: "https://media.your-site.com/token"
};
```

With `signEndpoint` set, the player requests `…/token?p=<path>` for the clip and
its thumbnail in one round trip, and lists of thumbnails are signed in a single
batched request per page. Leave it empty and everything falls back to plain URLs,
which is what a public bucket wants — so this is safe to ship in either mode.

The Worker checks the caller against `SITE_ORIGINS` before signing. The site's
own pages are same-origin, so their requests carry no `Origin` header — and the
pages set `referrer: no-referrer`, so no `Referer` either. Those are accepted,
while a request the browser marks `Sec-Fetch-Site: cross-site` is refused, which
is what stops another site from signing your media. `/token` is the only
unauthenticated endpoint, and it only ever returns a URL for the path asked for,
valid until `TOKEN_TTL`.

### Verified behaviour

Both suites run locally with no accounts and no deployment. The first needs
nothing at all; the second drives the **shipped** Worker file against a local
Backblaze stand-in that is also in this repo:

```bash
node tools/sigv4.test.mjs                        # signing, vs AWS's published vectors

node tools/b2-stand-in.mjs 8090 ./some-hls-dir &  # the stand-in (private bucket)
node worker/b2-cdn-worker.test.mjs               # the Worker, 25 checks
```

Between them they cover: the AWS-published signature vectors, a cross-check
against `aws4fetch`, signatures minted for one path being refused for another,
expired links, unsigned requests, HLS playlist rewriting (variant playlists,
segments and `EXT-X-MAP` init files, each signed for its own path), range
requests as 206, playlists never being cached, and the bucket genuinely refusing
anonymous reads.

---

## What this setup does and does not protect

**It does** stop direct downloads from Backblaze, stop hotlinking from other
sites, and expire links so a copied URL dies. **It cannot** stop the person
watching the video from copying the URL their own browser just requested — no
streaming site can, and anything claiming otherwise is obscuring rather than
protecting. If that matters, the real control is who can reach the page at all.

## Costs

| Item | Cost |
|---|---|
| B2 storage | ~$6/TB/month |
| B2 → Cloudflare egress | **free** (Bandwidth Alliance) |
| Cloudflare CDN egress | **free** |
| Worker requests | free tier covers 100k requests/day |

HLS multiplies request count: a 10-minute clip at 4-second segments is ~150
segment requests per viewing. Workers' free tier is generous but not infinite.
Watching the Worker's request metric is the honest way to know where you stand.

## Views and watch time

The same Worker can count per-clip views and watch time in a D1 database and
serve them to the admin panel — one write per session, no third-party script.
Setup takes about five minutes: `docs/STATISTICS.md`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Upload never reaches Backblaze | Missing CORS rules — run `tools/b2-setup.mjs` |
| Upload 403 | Key expired, wrong bucket scope, or clock skew |
| `/token` returns 403 | The site's origin is missing from `SITE_ORIGINS` |
| Media 403 with a valid token | Worker's clock/TTL, or `MEDIA_SIGNING_KEY` changed after the page loaded |
| Media 404 | The key does not exist — check the prefix and spelling |
| Worker 500 `no_signing_key` | `MEDIA_SIGNING_KEY` is not set |
| Plays in the admin but not on the site | Either the catalog was never published — watch the panel's publish line — or the published `catalog.js` still has the old base URL |
| A clip plays for you but nobody else sees it | Click **Publish live** in the admin panel. If it errors, the admin is not being served by the Worker or D1 is not bound as `DB`. GitHub Pages alone is static and cannot accept publishes |
| Everything 404s / `502 b2_unreachable` on the live domain | The Worker is missing `BUCKET_NAME` or the B2 key pair — run `node tools/b2-check.mjs` |
| Poster broken but video fine | Thumbnail was uploaded before signing was configured |
