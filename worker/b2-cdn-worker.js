/* ============================================================================
   ESMERINGHOY — CLOUDFLARE WORKER: SIGNED-URL CDN IN FRONT OF PRIVATE B2
   ----------------------------------------------------------------------------
   Paste this whole file into a Cloudflare Worker (Workers & Pages -> Create ->
   Worker) and add the variables listed below under Settings -> Variables.
   No build step, no npm install, no dependencies.

   WHAT IT DOES
     * Its bucket is private, so files cannot be downloaded from Backblaze
       directly. Everything goes through this Worker.
     * Backblaze does not charge for egress to Cloudflare (Bandwidth Alliance)
       and Cloudflare does not charge for egress to visitors, so delivery from
       a private bucket costs nothing beyond B2 storage.
     * Visitors never get a permanent URL. Every media URL carries an expiry and
       an HMAC signature that this Worker verifies before touching B2.
     * HLS works: playlists are rewritten on the way out so each variant
       playlist, segment and init map carries its own signature. hls.js will not
       propagate a query string on its own, which is why this matters.

   ROUTES
     GET  /token?p=<path>[&ttl=3600]   -> { url, expiresAt }        (site only)
     GET  /<path>?e=<exp>&s=<sig>      -> the file, cached at the edge
     HEAD /<path>?e=<exp>&s=<sig>      -> headers only
     OPTIONS *                         -> CORS preflight
     GET  /_health                     -> { ok, bucket, ... }

     GET    /comments?key=<id>[&owner=<token>] -> guest comments for a title
     POST   /comments                  -> post a comment
     PATCH  /comments                  -> edit your own comment
     DELETE /comments                  -> delete your own comment      PUT    /catalog                     -> save the live catalog (admin code)
      GET    /catalog.js                 -> live catalog when one is published
      GET    /views?key=<id>              -> live view count for a title
      POST   /views                       -> count one play
      GET    /votes?key=<id>&voter=<t>    -> vote totals + this browser's vote
      POST   /votes                       -> set or clear this browser's vote

      POST   /track                       -> count a view + its watch time (player)
      GET    /stats?days=7                -> aggregated reporting (admin panel only)

   VARIABLES (Settings -> Variables and Secrets)
     BUCKET_NAME          required   the B2 bucket name
     B2_KEY_ID            required   application key ID          (secret)
     B2_APPLICATION_KEY   required   application key             (secret)
     MEDIA_SIGNING_KEY    required   any long random string      (secret)
     SITE_ORIGINS         required   comma-separated origins allowed to call
                                     /token, e.g. https://esmeringhoy.com
                                     use * only if you accept open signing
     TOKEN_TTL            optional   seconds a signed URL stays valid (21600)
     CACHE_TTL            optional   edge cache seconds for segments (86400)
     ALLOW_UNSIGNED       optional   "true" disables signature checks entirely
     B2_API_URL           optional   override for testing (default the real API)
     STATS_TOKEN          required   password for /stats — never ship it to the
                                     site, only the admin panel uses it (secret)

   BINDINGS
     DB         optional but needed for statistics: a D1 database. The Worker
                creates its own tables on first use; you only create the
                database and bind it as DB. See docs/STATISTICS.md.

   Statistics are one write per playback session plus one per heartbeat — NOT
   one per request. Bandwidth and request counts belong in the Cloudflare
   dashboard, which already measures them for free.

   HOW THE SITE USES IT
     Point the media base URL at this Worker, set the sign endpoint, and the
     player asks /token for a fresh URL per clip. See docs/HOSTING.md and the
     ESH_MEDIA_SIGN_ENDPOINT setting in catalog.js.

   SECURITY NOTE, stated plainly: a signed URL stops *direct* downloads from
   Backblaze and hotlinking from other sites, and it expires. It cannot stop the
   person watching the video from copying the URL that their own browser
   requested — that is true of every streaming site.
   ========================================================================== */

/* ------------------------------------------------------------------ crypto -- */

const encoder = new TextEncoder();

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return out;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/* Length-independent comparison so a wrong signature cannot be guessed one
   character at a time. */
function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* The signature covers the path and the expiry, so neither can be altered. */
function signPath(signingKey, path, expiresAt) {
  return hmacHex(signingKey, path + ":" + expiresAt);
}

/* ------------------------------------------------------------------- paths -- */

/* A single canonical form for a bucket key: decoded, no leading slash, no
   traversal, no empty segments. Everything signs and fetches this exactly. */
function normalizePath(raw) {
  let path = String(raw == null ? "" : raw);
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  path = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!path) return null;
  const segments = path.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) return null;
  return path;
}

/* Bucket keys keep their slashes but everything else is percent-encoded. */
function encodeKey(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function withSignature(path, expiresAt, signature) {
  return "/" + encodeKey(path) + "?e=" + expiresAt + "&s=" + signature;
}

/* Resolves a playlist entry against the playlist it appeared in. */
function resolvePath(parentPath, reference) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) return null; /* absolute URL */
  const base = "https://media.invalid/" + encodeKey(parentPath);
  try {
    const resolved = new URL(reference, base);
    return normalizePath(resolved.pathname);
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- playlist -- */

/* The URI="..." attribute, as used by EXT-X-MAP, EXT-X-KEY and
   EXT-X-I-FRAME-STREAM-INF. Note the missing '#': the attribute is URI=, and
   matching the tag name instead silently rewrites the wrong thing. */
const URI_ATTRIBUTE = /URI=("?)([^",]+)\1/;

/* Rewrites every URI in a playlist so the signature travels with it.
   Async because the signature is computed with WebCrypto. */
async function rewritePlaylist(text, parentPath, expiresAt, signingKey) {
  const lines = text.split(/\r?\n/);
  const signatureFor = new Map();
  const sign = async (target) => {
    if (!signatureFor.has(target)) {
      signatureFor.set(target, await signPath(signingKey, target, expiresAt));
    }
    return signatureFor.get(target);
  };

  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }

    if (trimmed.startsWith("#")) {
      const match = URI_ATTRIBUTE.exec(line);
      const target = match ? resolvePath(parentPath, match[2]) : null;
      if (!match || !target) {
        out.push(line);
        continue;
      }
      /* Replace just the URI value, keeping quotes and the rest of the tag.
         "URI=" plus any opening quote is what precedes the value.
         The signature is awaited first because String.replace cannot await. */
      const valueStart = match.index + 4 + match[1].length;
      out.push(
        line.slice(0, valueStart) +
        withSignature(target, expiresAt, await sign(target)) +
        line.slice(valueStart + match[2].length)
      );
      continue;
    }

    const target = resolvePath(parentPath, trimmed);
    if (!target) {
      out.push(line);
      continue;
    }
    out.push(withSignature(target, expiresAt, await sign(target)));
  }
  return out.join("\n");
}

/* -------------------------------------------------------------- B2 access -- */

const API_ROOT_DEFAULT = "https://api.backblazeb2.com/b2api/v2";
const AUTH_TTL_MS = 20 * 60 * 60 * 1000; /* tokens last 24h; refresh well before */

/* Module scope survives between requests in the same isolate, which is what
   keeps this to roughly one authorize call per isolate per day. */
let authCache = null;

async function authorize(env, force) {
  if (!force && authCache && authCache.expiresAt > Date.now()) return authCache;

  const apiRoot = (env.B2_API_URL || API_ROOT_DEFAULT).replace(/\/+$/, "");
  const basic = btoa(env.B2_KEY_ID + ":" + env.B2_APPLICATION_KEY);
  const response = await fetch(apiRoot + "/b2_authorize_account", {
    headers: { Authorization: "Basic " + basic }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error("b2_authorize_account failed: HTTP " + response.status + " " + body.slice(0, 200));
  }

  const payload = await response.json();
  authCache = {
    token: payload.authorizationToken,
    downloadUrl: (env.B2_DOWNLOAD_URL || payload.downloadUrl).replace(/\/+$/, ""),
    bucketName: (payload.allowed && payload.allowed.bucketName) || env.BUCKET_NAME,
    expiresAt: Date.now() + AUTH_TTL_MS
  };
  return authCache;
}

async function fetchFromB2(env, path, request) {
  const headers = new Headers();
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  headers.set("Accept-Encoding", "identity");

  async function attempt(force) {
    const auth = await authorize(env, force);
    const bucket = env.BUCKET_NAME || auth.bucketName;
    headers.set("Authorization", auth.token);
    return fetch(auth.downloadUrl + "/file/" + encodeURIComponent(bucket) + "/" + encodeKey(path), {
      method: "GET",
      headers,
      redirect: "follow"
    });
  }

  let response = await attempt(false);
  /* A 401 here almost always means the cached token aged out. */
  if (response.status === 401) response = await attempt(true);
  return response;
}

/* ------------------------------------------------------------------- cache -- */

function cacheStore(env) {
  /* env.__cache is a test seam: Node has no caches.default. */
  if (env.__cache) return env.__cache;
  if (typeof caches !== "undefined" && caches.default) return caches.default;
  return null;
}

function cacheable(path, rangeHeader) {
  if (rangeHeader) return false;           /* never cache a partial body */
  if (/\.m3u8$/i.test(path)) return false; /* playlists are small and must be fresh */
  return true;
}

/* ------------------------------------------------------------------- CORS --- */

function allowedOrigins(env) {
  return String(env.SITE_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function originAllowed(env, origin) {
  const list = allowedOrigins(env);
  if (!origin) return false;
  return list.includes("*") || list.includes(origin);
}

/* Whether a request may be treated as coming from the site itself. Browsers
   send Origin on cross-origin calls, but a same-origin GET sends neither an
   Origin nor — with referrer policy no-referrer, which the pages set — a
   Referer, and that is exactly how the player asks for a signed URL. Refusing
   "no origin" outright would refuse the site's own pages, so a missing origin
   is accepted unless Sec-Fetch-Site says the request came from another site
   (that header is set by the browser regardless of referrer policy). */
function callerAllowed(env, request) {
  const origin = callerOrigin(request);
  if (origin) return originAllowed(env, origin);
  return request.headers.get("Sec-Fetch-Site") !== "cross-site";
}

function corsHeaders(env, origin, extra) {
  const headers = new Headers(extra);
  if (origin && originAllowed(env, origin)) {
    headers.set("Access-Control-Allow-Origin", origin === "null" ? "*" : origin);
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Range, Content-Type, Authorization, X-Admin-Code");
    headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag");
    headers.set("Access-Control-Max-Age", "86400");
    headers.set("Vary", "Origin");
  }
  return headers;
}

/* ------------------------------------------------------------------ errors -- */

function jsonResponse(env, origin, body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: corsHeaders(env, origin, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex"
    })
  });
}

/* ------------------------------------------------------------------ verify -- */

async function verifySignature(env, path, expiresAtRaw, signatureRaw) {
  if (String(env.ALLOW_UNSIGNED) === "true") return { ok: true, expiresAt: 0 };

  if (!env.MEDIA_SIGNING_KEY) {
    return { ok: false, status: 500, code: "no_signing_key", message: "MEDIA_SIGNING_KEY is not set" };
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || !expiresAtRaw) {
    return { ok: false, status: 403, code: "missing_expiry", message: "add ?e=<unix seconds>&s=<signature>" };
  }
  if (expiresAt * 1000 < Date.now()) {
    return { ok: false, status: 403, code: "expired", message: "this link expired; ask /token for a new one" };
  }
  const expected = await signPath(env.MEDIA_SIGNING_KEY, path, expiresAt);
  if (!sameHex(expected, signatureRaw || "")) {
    return { ok: false, status: 403, code: "bad_signature", message: "signature does not match this path" };
  }
  return { ok: true, expiresAt };
}

/* ============================================================================
   STATISTICS
   ----------------------------------------------------------------------------
   Views and watch time, measured here because a static site has nowhere else
   to measure them. Two moving parts:

     POST /track   the player reports a session: started, still playing, ended.
                   Authenticated with the same signed path the player is
                   already watching, so nobody can inflate your numbers without
                   a link that was issued to a real viewer.
     GET  /stats   aggregates for the admin panel, behind STATS_TOKEN.

   Watch time is deliberately server-authoritative: the client proposes a
   position, this code decides how many seconds that is worth, and no report
   can buy more seconds than the clock has actually passed since the previous
   one (plus two seconds of heartbeat slack), with a session-wide backstop so
   the total can never much outpace real time.
   ========================================================================== */

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/* A view is a session that really started playing; a bounce is not a view. */
const EVENTS = new Set(["start", "progress", "end"]);

/* One statement per string, run through prepare(). D1's exec() treats every
   LINE as a whole statement and rejects anything that spans lines ("incomplete
   input"), so a pretty-printed multi-line CREATE TABLE passes against a plain
   SQLite connection and fails on the real edge. Keeping each statement on one
   line and out of exec() is what makes this work in both. */
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS play_sessions (" +
    "id TEXT PRIMARY KEY, " +
    "key TEXT NOT NULL, " +
    "started_at INTEGER NOT NULL, " +
    "last_seen_at INTEGER NOT NULL, " +
    "watched_seconds REAL NOT NULL DEFAULT 0, " +
    "position REAL NOT NULL DEFAULT 0, " +
    "duration REAL, " +
    "completed INTEGER NOT NULL DEFAULT 0, " +
    "events INTEGER NOT NULL DEFAULT 0, " +
    "viewer TEXT, " +
    "country TEXT, " +
    "device TEXT, " +
    "referrer TEXT)",
  "CREATE INDEX IF NOT EXISTS play_sessions_started ON play_sessions (started_at)",
  "CREATE INDEX IF NOT EXISTS play_sessions_key ON play_sessions (key, started_at)",
  "CREATE TABLE IF NOT EXISTS comments (" +
    "id TEXT PRIMARY KEY, " +
    "key TEXT NOT NULL, " +
    "name TEXT NOT NULL, " +
    "body TEXT NOT NULL, " +
    "owner TEXT NOT NULL, " +
    "created_at INTEGER NOT NULL, " +
    "updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS comments_key ON comments (key, created_at)",
  "CREATE TABLE IF NOT EXISTS title_views (" +
    "key TEXT PRIMARY KEY, " +
    "views INTEGER NOT NULL DEFAULT 0, " +
    "updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS votes (" +
    "key TEXT NOT NULL, " +
    "voter TEXT NOT NULL, " +
    "value INTEGER NOT NULL, " +
    "updated_at INTEGER NOT NULL, " +
    "PRIMARY KEY (key, voter))",
  "CREATE INDEX IF NOT EXISTS votes_key ON votes (key)",
  "CREATE TABLE IF NOT EXISTS catalog (" +
    "id INTEGER PRIMARY KEY, " +
    "body TEXT NOT NULL, " +
    "updated_at INTEGER NOT NULL)"
];

/* One schema round trip per isolate, not per request. */
let schemaReady = false;

async function ensureSchema(env) {
  if (!env.DB || schemaReady) return;
  for (const statement of SCHEMA) await env.DB.prepare(statement).run();
  schemaReady = true;
}

/* The visitor's address as the platform reports it. Cloudflare always sets
   CF-Connecting-IP; the other two cover wrangler dev and a Worker behind
   another proxy, so "unique viewers" is not silently zero when this runs
   somewhere other than Cloudflare's edge. */
function visitorIp(request) {
  const direct = request.headers.get("CF-Connecting-IP");
  if (direct) return direct.trim();
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) return forwarded.split(",")[0].trim();
  const real = request.headers.get("X-Real-IP");
  return real ? real.trim() : null;
}

/* Identifies a returning viewer for a single day without storing an address:
   the day is part of the input, so yesterday's hash cannot be linked to today's. */
async function viewerHash(env, request, day) {
  const ip = visitorIp(request);
  if (!ip) return null;
  const salt = env.VIEWER_SALT || env.MEDIA_SIGNING_KEY || "esmeringhoy";
  return (await hmacHex(salt, day + "|" + ip)).slice(0, 16);
}

function countryOf(request) {
  const cf = request.cf || {};
  return typeof cf.country === "string" ? cf.country : null;
}

function deviceOf(userAgent) {
  const ua = String(userAgent || "");
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return "tablet";
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "phone";
  if (/TV|SmartTV|AppleTV|Roku/i.test(ua)) return "tv";
  if (!ua) return null;
  return "desktop";
}

/* A short-lived signature is also the credential for reporting a view, so a
   beacon is only accepted for a path the Worker actually handed out. The
   signature travels in the body, alongside the text/plain content type, which
   keeps every heartbeat a "simple" CORS request: no preflight, and callable
   from navigator.sendBeacon, which cannot set request headers at all. */
async function beaconSignature(env, beacon, key) {
  /* A public bucket has no signatures to check, so nothing is required. */
  if (!env.MEDIA_SIGNING_KEY || String(env.TRACK_REQUIRE_SIGNATURE) === "false") {
    return { ok: true, expiresAt: 0 };
  }
  return verifySignature(env, key, beacon.exp, beacon.sig);
}

function referrerHost(request) {
  const ref = request.headers.get("Referer");
  if (!ref) return null;
  try {
    return new URL(ref).host;
  } catch {
    return null;
  }
}

async function readBeacon(request) {
  const text = await request.text().catch(() => "");
  if (!text || text.length > 4096) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/* Slack for heartbeat jitter and for the moment between two reports. */
const CREDIT_SLACK_SECONDS = 2;

/* Decide how many seconds of a heartbeat to believe.

   Two limits, and the tighter one wins:

     1. Only forward progress since the last report counts. Seeking backwards
        earns nothing on its own, but replaying a stretch does — the position
        moved forward again, and that time was really watched.
     2. No report can credit more than the wall-clock time since the previous
        report. Watch time therefore cannot outrun real time no matter what the
        client claims: "I watched an hour", sent one second after the last
        beacon, is worth three seconds.

   The remaining assumption is unavoidable and worth stating: a client that
   reports plausible positions on a real-time cadence is indistinguishable from
   a viewer. Nothing a server can see tells those apart. */
function creditSeconds(row, beacon, now) {
  if (!row) return 0;
  const position = Number(beacon.position);
  if (beacon.playing === false || !Number.isFinite(position)) return 0;

  const delta = position - Number(row.position || 0);
  if (delta <= 0) return 0;

  const elapsed = Math.max(1, now - Number(row.last_seen_at || row.started_at));
  const earned = Math.min(delta, elapsed + CREDIT_SLACK_SECONDS);

  /* Backstop on the total, so a long-lived session cannot accumulate more than
     the clip's own length repeated in real time. */
  const sessionAge = Math.max(1, now - row.started_at);
  const ceiling = sessionAge * 1.5 + 10;
  return Math.max(0, Math.min(Number(row.watched_seconds) + earned, ceiling) - Number(row.watched_seconds));
}

async function trackRequest(request, env, ctx, origin) {
  if (String(env.TRACKING || "on").toLowerCase() === "off") {
    return jsonResponse(env, origin, { ok: true, stored: false, reason: "tracking_disabled" });
  }
  if (request.method !== "POST") {
    return jsonResponse(env, origin, { error: "method_not_allowed", message: "POST a JSON body" }, 405);
  }

  /* Only the site may report. A signed link is the credential; without one the
     endpoint would be a free "inflate my numbers" button. A side-effect of the
     same-origin rule above: the beacons the tracker sends carry no Origin on
     some paths, so the shared check is used here too. */
  if (!callerAllowed(env, request)) {
    return jsonResponse(env, null, { error: "origin_not_allowed" }, 403);
  }

  const beacon = await readBeacon(request);
  if (!beacon) return jsonResponse(env, origin, { error: "bad_body" }, 400);

  const key = normalizePath(beacon.path);
  if (!key) return jsonResponse(env, origin, { error: "bad_path" }, 400);

  /* The signature is checked before anything is written, so an unsigned or
     expired "beacon" cannot inflate the numbers. */
  const verified = await beaconSignature(env, beacon, key);
  if (!verified.ok) {
    return jsonResponse(env, origin, { error: verified.code, message: verified.message }, verified.status || 403);
  }

  const session = String(beacon.session || "");
  if (!SESSION_ID.test(session)) return jsonResponse(env, origin, { error: "bad_session" }, 400);

  const event = EVENTS.has(beacon.event) ? beacon.event : "progress";
  const duration = Number.isFinite(Number(beacon.duration)) ? Math.max(0, Number(beacon.duration)) : null;
  let position = Number.isFinite(Number(beacon.position)) ? Math.max(0, Number(beacon.position)) : 0;
  if (duration) position = Math.min(position, duration * 2);

  if (!env.DB) {
    /* Nothing to write to. That must be visible but must never break playback. */
    return jsonResponse(env, origin, { ok: true, stored: false, reason: "no_database", setup: SETUP_HELP });
  }

  await ensureSchema(env);

  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const existing = await env.DB.prepare("SELECT * FROM play_sessions WHERE id = ?").bind(session).first();

  if (!existing) {
    /* A view is a session in which playback actually happened. A player that
       polls or preloads must not create one. */
    if (beacon.playing === false) {
      return jsonResponse(env, origin, { ok: true, stored: false, reason: "not_playing" });
    }
    const viewer = await viewerHash(env, request, day);
    /* The stored position starts at zero, not at the position reported here, so
       the seconds played before the view was recorded are still credited by the
       next report instead of being silently dropped. */
    const statement = env.DB.prepare(
      "INSERT OR IGNORE INTO play_sessions " +
      "(id, key, started_at, last_seen_at, watched_seconds, position, duration, completed, events, viewer, country, device, referrer) " +
      "VALUES (?, ?, ?, ?, 0, 0, ?, 0, 1, ?, ?, ?, ?)"
    ).bind(session, key, now, now, duration, viewer, countryOf(request), deviceOf(request.headers.get("User-Agent")), referrerHost(request));
    ctx.waitUntil(statement.run().catch(() => {}));
    return jsonResponse(env, origin, { ok: true, stored: true, session: session, counted: "view" });
  }

  const credited = creditSeconds(existing, { position, playing: beacon.playing !== false }, now);
  const watched = existing.watched_seconds + credited;
  const completed = existing.completed || event === "end" || (duration && position >= duration - 1) ? 1 : 0;

  ctx.waitUntil(
    env.DB.prepare(
      "UPDATE play_sessions SET last_seen_at = ?, watched_seconds = ?, position = ?, " +
      "duration = COALESCE(?, duration), completed = ?, events = events + 1 WHERE id = ?"
    ).bind(now, watched, position, duration, completed, session).run().catch(() => {})
  );

  return jsonResponse(env, origin, {
    ok: true,
    stored: true,
    session: session,
    creditedSeconds: Number(credited.toFixed(2)),
    watchedSeconds: Number(watched.toFixed(2)),
    completed: Boolean(completed)
  });
}

/* Constant-time compare, so the token cannot be guessed character by character. */
function tokenMatches(env, provided) {
  const expected = env.STATS_TOKEN || "";
  if (!expected || !provided) return false;
  return sameHex(expected, provided);
}

function statsToken(request, url) {
  const header = request.headers.get("Authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  return bearer ? bearer[1].trim() : (url.searchParams.get("token") || "");
}

const SETUP_HELP = [
  "Statistics need a D1 database bound to this Worker as DB:",
  "1. npx wrangler d1 create esh-stats",
  "2. Workers & Pages -> your Worker -> Settings -> Bindings -> Add -> D1, variable name DB",
  "3. Set STATS_TOKEN (any long random string) under Variables and Secrets",
  "4. Redeploy. The tables are created on the first recorded view.",
  "Full walkthrough: docs/STATISTICS.md"
];

async function statsRequest(request, env, origin, url) {
  if (request.method !== "GET") {
    return jsonResponse(env, origin, { error: "method_not_allowed" }, 405);
  }
  /* Same allowlist as /token: your numbers are not readable from any origin, and
     the password is a second lock rather than the only one. The panel itself
     asks from the site's own origin, so a same-origin GET carries no Origin. */
  if (!callerAllowed(env, request)) {
    return jsonResponse(env, null, {
      error: "origin_not_allowed",
      message: origin
        ? "Add " + origin + " to SITE_ORIGINS."
        : "Cross-site request with no Origin; add the calling origin to SITE_ORIGINS."
    }, 403);
  }
  if (!env.STATS_TOKEN) {
    return jsonResponse(env, origin, { error: "no_stats_token", setupRequired: true, steps: SETUP_HELP }, 501);
  }
  if (!tokenMatches(env, statsToken(request, url))) {
    return jsonResponse(env, origin, { error: "unauthorized", message: "send Authorization: Bearer <STATS_TOKEN>" }, 401);
  }
  if (!env.DB) {
    return jsonResponse(env, origin, { error: "no_database", setupRequired: true, steps: SETUP_HELP }, 501);
  }

  await ensureSchema(env);

  const daysRaw = Number(url.searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 3650) : 0;
  const since = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
  const keyFilter = normalizePath(url.searchParams.get("key"));

  const where = [];
  const params = [];
  if (since) { where.push("started_at >= ?"); params.push(since); }
  if (keyFilter) { where.push("key = ?"); params.push(keyFilter); }
  const clause = where.length ? " WHERE " + where.join(" AND ") : "";

  const clips = (await env.DB.prepare(
    "SELECT key, COUNT(*) AS views, SUM(watched_seconds) AS watch_seconds, " +
    "SUM(completed) AS completions, COUNT(DISTINCT viewer) AS unique_viewers, " +
    "MAX(last_seen_at) AS last_seen, AVG(watched_seconds) AS avg_seconds " +
    "FROM play_sessions" + clause + " GROUP BY key ORDER BY views DESC LIMIT 200"
  ).bind(...params).all()).results || [];

  const totalsRow = (await env.DB.prepare(
    "SELECT COUNT(*) AS views, SUM(watched_seconds) AS watch_seconds, " +
    "SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS completions, " +
    "COUNT(DISTINCT viewer) AS unique_viewers, MAX(last_seen_at) AS last_seen " +
    "FROM play_sessions" + clause
  ).bind(...params).first()) || {};

  const daily = (await env.DB.prepare(
    "SELECT date(started_at, 'unixepoch') AS day, COUNT(*) AS views, " +
    "SUM(watched_seconds) AS watch_seconds FROM play_sessions" + clause +
    " GROUP BY day ORDER BY day DESC LIMIT 120"
  ).bind(...params).all()).results || [];

  const devices = (await env.DB.prepare(
    "SELECT device, COUNT(*) AS views FROM play_sessions" + clause +
    " GROUP BY device ORDER BY views DESC"
  ).bind(...params).all()).results || [];

  /* Built separately: the country filter is an extra condition, not a second
     WHERE — appending " WHERE" to an existing clause is a syntax error. */
  const countryWhere = where.concat(["country IS NOT NULL"]);
  const countries = (await env.DB.prepare(
    "SELECT country, COUNT(*) AS views FROM play_sessions WHERE " +
    countryWhere.join(" AND ") + " GROUP BY country ORDER BY views DESC LIMIT 10"
  ).bind(...params).all()).results || [];

  const round = (n) => Math.round((Number(n) || 0) * 10) / 10;
  const views = Number(totalsRow.views) || 0;
  const watchSeconds = Number(totalsRow.watch_seconds) || 0;

  return jsonResponse(env, origin, {
    generatedAt: Math.floor(Date.now() / 1000),
    range: { days: days || null, since: since || null },
    totals: {
      views: views,
      watchSeconds: round(watchSeconds),
      watchHours: round(watchSeconds / 3600),
      avgSeconds: views ? round(watchSeconds / views) : 0,
      completions: Number(totalsRow.completions) || 0,
      uniqueViewers: Number(totalsRow.unique_viewers) || 0,
      lastSeen: Number(totalsRow.last_seen) || null,
      devices: devices,
      countries: countries
    },
    clips: clips.map((row) => ({
      key: row.key,
      views: Number(row.views) || 0,
      watchSeconds: round(row.watch_seconds),
      avgSeconds: round(row.avg_seconds),
      completions: Number(row.completions) || 0,
      uniqueViewers: Number(row.unique_viewers) || 0,
      lastSeen: Number(row.last_seen) || null
    })),
    daily: daily.map((row) => ({
      day: row.day,
      views: Number(row.views) || 0,
      watchSeconds: round(row.watch_seconds)
    }))
  });
}

/* ============================================================================
   COMMENTS
   ----------------------------------------------------------------------------
   Guest comments, stored in D1 and shared by every visitor.

     GET    /comments?key=<video id>&owner=<token>  -> { comments: [...] }
     POST   /comments                               -> { comment: {...} }
     PATCH  /comments                               -> { comment: {...} }
     DELETE /comments                               -> { ok: true }

   A comment belongs to the browser that posted it, not to an account: the
   client generates a random owner token, keeps it in localStorage, and sends it
   only when editing or deleting. The database stores an HMAC of that token, so
   a leaked database cannot be used to take over comments, and list responses
   never include it.
   ========================================================================== */

const COMMENT_KEY = /^[A-Za-z0-9_-]{1,80}$/;
const COMMENT_OWNER = /^[A-Za-z0-9_-]{16,80}$/;
const COMMENT_ID = /^[a-f0-9]{32}$/;
const COMMENT_MAX_NAME = 32;
const COMMENT_MAX_BODY = 1000;
const COMMENT_LIMIT = 200;

function commentName(value) {
  const name = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, COMMENT_MAX_NAME);
  return name || "Anonymous" + Math.floor(10000 + Math.random() * 90000);
}

function commentBody(value) {
  return String(value == null ? "" : value).trim().slice(0, COMMENT_MAX_BODY);
}

async function commentOwnerHash(env, token) {
  const salt = env.MEDIA_SIGNING_KEY || "esmeringhoy-comments";
  return (await hmacHex(salt, "comment-owner:" + token)).slice(0, 32);
}

async function readCommentBody(request) {
  const text = await request.text().catch(() => "");
  if (!text || text.length > 8192) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function commentObject(row, ownerHash) {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    owned: Boolean(ownerHash) && sameHex(row.owner, ownerHash)
  };
}

async function commentsRequest(request, env, origin, url) {
  if (!callerAllowed(env, request)) {
    return jsonResponse(env, null, {
      error: "origin_not_allowed",
      message: origin
        ? "Add " + origin + " to SITE_ORIGINS."
        : "Cross-site request with no Origin; add the calling origin to SITE_ORIGINS."
    }, 403);
  }

  if (!env.DB) {
    return jsonResponse(env, origin, {
      error: "no_database",
      message: "Comments need the D1 database bound to this Worker as DB."
    }, 501);
  }

  await ensureSchema(env);

  const token = String(url.searchParams.get("owner") || "");
  const ownerHash = COMMENT_OWNER.test(token) ? await commentOwnerHash(env, token) : "";

  if (request.method === "GET") {
    const key = String(url.searchParams.get("key") || "");
    if (!COMMENT_KEY.test(key)) {
      return jsonResponse(env, origin, { error: "bad_key", message: "Pass ?key=<video id>." }, 400);
    }

    const rows = (await env.DB.prepare(
      "SELECT id, name, body, owner, created_at, updated_at FROM comments WHERE key = ? " +
      "ORDER BY created_at DESC LIMIT ?"
    ).bind(key, COMMENT_LIMIT).all()).results || [];

    return jsonResponse(env, origin, {
      comments: rows.map((row) => commentObject(row, ownerHash))
    });
  }

  const body = await readCommentBody(request);
  if (!body) {
    return jsonResponse(env, origin, { error: "bad_body", message: "Send a JSON body." }, 400);
  }

  if (request.method === "POST") {
    const key = String(body.key || "");
    const owner = String(body.owner || "");
    if (!COMMENT_KEY.test(key)) {
      return jsonResponse(env, origin, { error: "bad_key", message: "A valid video id is required." }, 400);
    }
    if (!COMMENT_OWNER.test(owner)) {
      return jsonResponse(env, origin, { error: "bad_owner", message: "A valid owner token is required." }, 400);
    }

    const text = commentBody(body.body);
    if (!text) {
      return jsonResponse(env, origin, { error: "empty_body", message: "Write something first." }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const comment = {
      id: crypto.randomUUID().replace(/-/g, ""),
      name: commentName(body.name),
      body: text
    };

    await env.DB.prepare(
      "INSERT INTO comments (id, key, name, body, owner, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(comment.id, key, comment.name, comment.body, await commentOwnerHash(env, owner), now, now).run();

    return jsonResponse(env, origin, {
      comment: {
        id: comment.id,
        name: comment.name,
        body: comment.body,
        createdAt: now,
        updatedAt: now,
        owned: true
      }
    });
  }

  if (request.method === "PATCH" || request.method === "DELETE") {
    const id = String(body.id || "");
    const owner = String(body.owner || "");
    if (!COMMENT_ID.test(id)) {
      return jsonResponse(env, origin, { error: "bad_id", message: "A valid comment id is required." }, 400);
    }
    if (!COMMENT_OWNER.test(owner)) {
      return jsonResponse(env, origin, { error: "bad_owner", message: "A valid owner token is required." }, 400);
    }

    const existing = await env.DB.prepare(
      "SELECT id, name, body, owner, created_at, updated_at FROM comments WHERE id = ?"
    ).bind(id).first();

    /* Deleting something already gone is the outcome the caller wanted. */
    if (!existing) {
      return request.method === "DELETE"
        ? jsonResponse(env, origin, { ok: true, id: id })
        : jsonResponse(env, origin, { error: "not_found" }, 404);
    }

    if (!sameHex(existing.owner, await commentOwnerHash(env, owner))) {
      return jsonResponse(env, origin, {
        error: "not_owner",
        message: "This comment belongs to another browser."
      }, 403);
    }

    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
      return jsonResponse(env, origin, { ok: true, id: id });
    }

    const text = commentBody(body.body);
    if (!text) {
      return jsonResponse(env, origin, { error: "empty_body", message: "Write something first." }, 400);
    }

    const name = commentName(body.name);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "UPDATE comments SET name = ?, body = ?, updated_at = ? WHERE id = ?"
    ).bind(name, text, now, id).run();

    return jsonResponse(env, origin, {
      comment: {
        id: id,
        name: name,
        body: text,
        createdAt: Number(existing.created_at),
        updatedAt: now,
        owned: true
      }
    });
  }

  return jsonResponse(env, origin, { error: "method_not_allowed" }, 405);
}

/* ============================================================================
   CATALOG, VIEWS AND VOTES
   ----------------------------------------------------------------------------
   catalog.js is normally a static asset. Once an admin publishes, this Worker
   serves that file from D1 instead, so every page picks the new catalog up on
   its next load without a redeploy.

     GET /catalog                 -> the stored catalog as JSON
     PUT /catalog                 -> publish it (X-Admin-Code required)
     GET /views?key=<video id>    -> live view total
     POST /views                  -> record one view
     GET /votes?key=<id>&voter=   -> like/dislike totals + this browser's vote
     POST /votes                  -> set / change / clear this browser's vote
   ========================================================================== */

const VIDEO_KEY = /^[A-Za-z0-9_-]{1,80}$/;

function adminCodeOk(env, request) {
  const provided = request.headers.get("X-Admin-Code") || "";
  const expected = env.ADMIN_CODE || "050603";
  return sameHex(provided, expected);
}

async function readLargeBody(request, limit) {
  const text = await request.text().catch(() => "");
  if (!text || text.length > limit) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function cleanUrl(value) {
  const url = String(value == null ? "" : value).trim().slice(0, 2000);
  return url || null;
}

/* Accept only the fields the site can actually render. Everything is clipped to
   a sane length, so a bad publish cannot store a 50 MB row or a broken shape. */
function normalizeCatalog(input) {
  if (!input || !Array.isArray(input.videos) || input.videos.length > 500) return null;

  const videos = [];
  const seen = new Set();

  for (const raw of input.videos) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || "").trim();
    const title = String(raw.title || "").trim().slice(0, 200);
    if (!VIDEO_KEY.test(id) || !title || seen.has(id)) return null;
    seen.add(id);

    const video = {
      id: id,
      title: title,
      description: String(raw.description || "").trim().slice(0, 2000),
      poster: cleanUrl(raw.poster),
      video: cleanUrl(raw.video),
      duration: String(raw.duration || "").slice(0, 20),
      views: Math.max(0, Number(raw.views) || 0),
      rating: Math.max(0, Math.min(100, Number(raw.rating) || 0)),
      added: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.added || ""))
        ? String(raw.added)
        : new Date().toISOString().slice(0, 10),
      tags: (Array.isArray(raw.tags) ? raw.tags : [])
        .map((tag) => String(tag).trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 20)
    };

    if (Array.isArray(raw.clips)) {
      video.clips = raw.clips
        .map((clip, i) => ({
          label: String((clip && clip.label) || i + 1).slice(0, 20),
          video: cleanUrl(clip && clip.video)
        }))
        .filter((clip) => Boolean(clip.video))
        .slice(0, 200);
    }

    if (Array.isArray(raw.gallery)) {
      video.gallery = raw.gallery
        .map(cleanUrl)
        .filter(Boolean)
        .slice(0, 500);
    }

    videos.push(video);
  }

  const categories = (Array.isArray(input.categories) ? input.categories : [])
    .map((name) => String(name).trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 40);

  const media = {
    b2BaseUrl: String((input.media && input.media.b2BaseUrl) || "").trim().slice(0, 500),
    signEndpoint: String((input.media && input.media.signEndpoint) || "").trim().slice(0, 500)
  };

  return { videos: videos, categories: categories, media: media };
}

function catalogJs(catalog) {
  return (
    "/* ESMERINGHOY — live catalog (served from D1) */\n" +
    "window.ESMERINGHOY_MEDIA = " + JSON.stringify(catalog.media || {}, null, 2) + ";\n\n" +
    "window.ESMERINGHOY_CATEGORIES = " + JSON.stringify(catalog.categories || [], null, 2) + ";\n\n" +
    "window.ESMERINGHOY_VIDEOS = " + JSON.stringify(catalog.videos || [], null, 2) + ";\n"
  );
}

async function catalogRequest(request, env, origin, url) {
  if (!callerAllowed(env, request)) {
    return jsonResponse(env, null, {
      error: "origin_not_allowed",
      message: origin ? "Add " + origin + " to SITE_ORIGINS." : "Add the calling origin to SITE_ORIGINS."
    }, 403);
  }
  if (!env.DB) {
    return jsonResponse(env, origin, {
      error: "no_database",
      message: "Live publishing needs the D1 database bound as DB."
    }, 501);
  }

  await ensureSchema(env);

  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT body, updated_at FROM catalog WHERE id = 1").first();
    if (!row) return jsonResponse(env, origin, { catalog: null });
    let catalog = null;
    try { catalog = JSON.parse(row.body); } catch { catalog = null; }
    return jsonResponse(env, origin, { catalog: catalog, updatedAt: Number(row.updated_at) || null });
  }

  if (request.method === "PUT") {
    if (!adminCodeOk(env, request)) {
      return jsonResponse(env, origin, {
        error: "unauthorized",
        message: "The admin code is missing or wrong."
      }, 403);
    }

    const input = await readLargeBody(request, 2 * 1024 * 1024);
    const catalog = normalizeCatalog(input);
    if (!catalog) {
      return jsonResponse(env, origin, {
        error: "bad_catalog",
        message: "The catalog payload is invalid or too large."
      }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify(catalog);
    const existing = await env.DB.prepare("SELECT id FROM catalog WHERE id = 1").first();

    if (existing) {
      await env.DB.prepare("UPDATE catalog SET body = ?, updated_at = ? WHERE id = 1")
        .bind(body, now).run();
    } else {
      await env.DB.prepare("INSERT INTO catalog (id, body, updated_at) VALUES (1, ?, ?)")
        .bind(body, now).run();
    }

    return jsonResponse(env, origin, {
      ok: true,
      updatedAt: now,
      clips: catalog.videos.length
    });
  }

  return jsonResponse(env, origin, { error: "method_not_allowed" }, 405);
}

async function liveCatalogResponse(request, env) {
  if (!env.DB) return null;

  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT body FROM catalog WHERE id = 1").first();
  if (!row || !row.body) return null;

  let catalog = null;
  try { catalog = JSON.parse(row.body); } catch { return null; }

  return new Response(request.method === "HEAD" ? null : catalogJs(catalog), {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex"
    }
  });
}

async function viewsRequest(request, env, origin, url) {
  if (!callerAllowed(env, request)) {
    return jsonResponse(env, null, { error: "origin_not_allowed" }, 403);
  }
  if (!env.DB) {
    return jsonResponse(env, origin, { error: "no_database", message: "Views need the D1 database." }, 501);
  }

  await ensureSchema(env);

  let key = String(url.searchParams.get("key") || "");
  let increment = false;

  if (request.method === "POST") {
    const body = await readCommentBody(request);
    if (!body) return jsonResponse(env, origin, { error: "bad_body" }, 400);
    key = String(body.key || "");
    increment = true;
  } else if (request.method !== "GET") {
    return jsonResponse(env, origin, { error: "method_not_allowed" }, 405);
  }

  if (!VIDEO_KEY.test(key)) {
    return jsonResponse(env, origin, { error: "bad_key", message: "Pass a video id." }, 400);
  }

  if (increment) {
    const now = Math.floor(Date.now() / 1000);
    const existing = await env.DB.prepare("SELECT key FROM title_views WHERE key = ?").bind(key).first();
    if (existing) {
      await env.DB.prepare("UPDATE title_views SET views = views + 1, updated_at = ? WHERE key = ?")
        .bind(now, key).run();
    } else {
      await env.DB.prepare("INSERT INTO title_views (key, views, updated_at) VALUES (?, 1, ?)")
        .bind(key, now).run();
    }
  }

  const row = await env.DB.prepare("SELECT views FROM title_views WHERE key = ?").bind(key).first();
  return jsonResponse(env, origin, { key: key, views: Number(row && row.views) || 0 });
}

async function voterHash(env, token) {
  const salt = env.MEDIA_SIGNING_KEY || "esmeringhoy-votes";
  return (await hmacHex(salt, "vote:" + token)).slice(0, 32);
}

async function voteSummary(env, key, hash) {
  const counts = await env.DB.prepare(
    "SELECT SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes, " +
    "SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes FROM votes WHERE key = ?"
  ).bind(key).first();

  const mine = hash
    ? await env.DB.prepare("SELECT value FROM votes WHERE key = ? AND voter = ?").bind(key, hash).first()
    : null;

  return {
    likes: Number(counts && counts.likes) || 0,
    dislikes: Number(counts && counts.dislikes) || 0,
    mine: Number(mine && mine.value) || 0
  };
}

async function votesRequest(request, env, origin, url) {
  if (!callerAllowed(env, request)) {
    return jsonResponse(env, null, { error: "origin_not_allowed" }, 403);
  }
  if (!env.DB) {
    return jsonResponse(env, origin, { error: "no_database", message: "Votes need the D1 database." }, 501);
  }

  await ensureSchema(env);

  let key = String(url.searchParams.get("key") || "");
  let voter = String(url.searchParams.get("voter") || "");
  let value = null;

  if (request.method === "POST") {
    const body = await readCommentBody(request);
    if (!body) return jsonResponse(env, origin, { error: "bad_body" }, 400);
    key = String(body.key || "");
    voter = String(body.voter || "");
    value = Number(body.value);
    if (![1, -1, 0].includes(value)) {
      return jsonResponse(env, origin, { error: "bad_value", message: "value must be 1, -1 or 0." }, 400);
    }
  } else if (request.method !== "GET") {
    return jsonResponse(env, origin, { error: "method_not_allowed" }, 405);
  }

  if (!VIDEO_KEY.test(key)) {
    return jsonResponse(env, origin, { error: "bad_key", message: "Pass a video id." }, 400);
  }
  if (voter && !COMMENT_OWNER.test(voter)) {
    return jsonResponse(env, origin, { error: "bad_voter" }, 400);
  }

  const hash = voter ? await voterHash(env, voter) : "";

  if (request.method === "POST") {
    const now = Math.floor(Date.now() / 1000);
    if (value === 0) {
      await env.DB.prepare("DELETE FROM votes WHERE key = ? AND voter = ?").bind(key, hash).run();
    } else {
      const existing = await env.DB.prepare(
        "SELECT value FROM votes WHERE key = ? AND voter = ?"
      ).bind(key, hash).first();

      if (existing) {
        await env.DB.prepare(
          "UPDATE votes SET value = ?, updated_at = ? WHERE key = ? AND voter = ?"
        ).bind(value, now, key, hash).run();
      } else {
        await env.DB.prepare(
          "INSERT INTO votes (key, voter, value, updated_at) VALUES (?, ?, ?, ?)"
        ).bind(key, hash, value, now).run();
      }
    }
  }

  return jsonResponse(env, origin, await voteSummary(env, key, hash));
}

/* ------------------------------------------------------------------ handler -- */

/* Who is asking: the Origin header when the browser sends one, otherwise the
   Referer, so an admin panel opened from the filesystem (Origin: null) is
   still checked against SITE_ORIGINS rather than waved through. */
function callerOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin) return origin;
  const ref = request.headers.get("Referer");
  if (!ref) return null;
  try {
    return new URL(ref).origin;
  } catch {
    return null;
  }
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const requestOrigin = callerOrigin(request);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
  }

  /* ---------------------------------------------------------- statistics -- */

  /* Handled before the method guard below, which is deliberately GET/HEAD only. */
  if (url.pathname === "/track" || url.pathname === "/track/") {
    return trackRequest(request, env, ctx, requestOrigin);
  }
  if (url.pathname === "/stats" || url.pathname === "/stats/") {
    /* Never let a shared cache hold one viewer's reporting. */
    const response = await statsRequest(request, env, requestOrigin, url);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  /* -------------------------------------------------------------- comments -- */

  if (url.pathname === "/comments" || url.pathname === "/comments/") {
    const response = await commentsRequest(request, env, requestOrigin, url);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (url.pathname === "/views" || url.pathname === "/views/") {
    const response = await viewsRequest(request, env, requestOrigin, url);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (url.pathname === "/votes" || url.pathname === "/votes/") {
    const response = await votesRequest(request, env, requestOrigin, url);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (url.pathname === "/catalog" || url.pathname === "/catalog/") {
    const response = await catalogRequest(request, env, requestOrigin, url);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(env, origin, { error: "method_not_allowed" }, 405);
  }

  /* ---------------------------------------------------------------- token -- */

  if (url.pathname === "/token" || url.pathname === "/token/") {
    if (!callerAllowed(env, request)) {
      return jsonResponse(env, null, {
        error: "origin_not_allowed",
        message: requestOrigin
          ? "Add " + requestOrigin + " to SITE_ORIGINS."
          : "Cross-site request with no Origin; add the calling origin to SITE_ORIGINS."
      }, 403);
    }
    if (!env.MEDIA_SIGNING_KEY) {
      return jsonResponse(env, requestOrigin, { error: "no_signing_key" }, 500);
    }

    const requested = url.searchParams.getAll("p").map(normalizePath);
    if (!requested.length || requested.some((p) => !p)) {
      return jsonResponse(env, requestOrigin, { error: "bad_path", message: "pass ?p=<bucket path>" }, 400);
    }

    const ttlOverride = Number(url.searchParams.get("ttl"));
    const ttl = Number.isFinite(ttlOverride) && ttlOverride > 0
      ? Math.min(ttlOverride, 604800)
      : Number(env.TOKEN_TTL) || 21600;

    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    const entries = {};
    for (const path of requested) {
      entries[path] = withSignature(path, expiresAt, await signPath(env.MEDIA_SIGNING_KEY, path, expiresAt));
    }
    return jsonResponse(env, requestOrigin, {
      expiresAt: expiresAt,
      url: entries[requested[0]],
      urls: entries
    });
  }

  if (url.pathname === "/_health") {
    return jsonResponse(env, origin, {
      ok: true,
      bucket: env.BUCKET_NAME || null,
      signing: Boolean(env.MEDIA_SIGNING_KEY),
      allowUnsigned: String(env.ALLOW_UNSIGNED) === "true",
      siteOrigins: allowedOrigins(env),
      tracking: {
        enabled: String(env.TRACKING || "on").toLowerCase() !== "off",
        database: env.DB ? "bound" : "missing",
        statsEndpoint: env.STATS_TOKEN ? "locked" : "unconfigured"
      }
    });
  }

  /* The live catalog, when one has been published. Without it the static
     catalog.js asset below is served, so a fresh install still works. */
  if (url.pathname === "/catalog.js") {
    const live = await liveCatalogResponse(request, env);
    if (live) return live;
  }

  /* --------------------------------------------------------------- assets -- */

  /* The static site rides along beside the API routes when this Worker is
     deployed with a directory of assets (see wrangler.toml). Anything this
     Worker does not recognise as one of its own routes is looked up there
     first; a signed media URL misses the assets and falls through to the
     signature check below, exactly as before. */
  if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;

    /* wrangler.toml sets html_handling = "none" so that the pages linked as
       player.html / admin.html serve directly instead of answering 307 to the
       extensionless path. The other side of that setting is that the asset
       server matches names exactly: "/" is not index.html and "/player" is not
       player.html. Resolve both here, which costs one extra lookup only for
       paths that already missed the assets. */
    if (!/\.[A-Za-z0-9]+$/.test(url.pathname)) {
      const candidate = url.pathname.endsWith("/")
        ? url.pathname + "index.html"
        : url.pathname + ".html";
      const target = new URL(url.href);
      target.pathname = candidate;
      const retried = await env.ASSETS.fetch(new Request(target, request));
      if (retried.status !== 404) return retried;
    }
  }

  /* ---------------------------------------------------------------- media -- */

  const path = normalizePath(url.pathname);
  if (!path) return jsonResponse(env, origin, { error: "bad_path" }, 400);

  const verified = await verifySignature(env, path, url.searchParams.get("e"), url.searchParams.get("s"));
  if (!verified.ok) {
    return jsonResponse(env, origin, { error: verified.code, message: verified.message }, verified.status || 403);
  }

  const rangeHeader = request.headers.get("Range");
  const store = cacheStore(env);
  const cacheKey = "https://esh-cache.invalid/" + encodeKey(path);

  if (store && request.method === "GET" && cacheable(path, rangeHeader)) {
    const hit = await store.match(cacheKey).catch(() => null);
    if (hit) {
      const headers = corsHeaders(env, origin, hit.headers);
      headers.set("X-Cache", "HIT");
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  let upstream;
  try {
    upstream = await fetchFromB2(env, path, request);
  } catch (err) {
    return jsonResponse(env, origin, { error: "b2_unreachable", message: String(err && err.message || err) }, 502);
  }

  if (upstream.status === 404 || upstream.status === 401) {
    return jsonResponse(env, origin, {
      error: upstream.status === 404 ? "not_found" : "b2_rejected_key",
      message: upstream.status === 401
        ? "Backblaze rejected the key — check B2_KEY_ID / B2_APPLICATION_KEY and the bucket scope."
        : "No such object in the bucket: " + path,
      path: path
    }, upstream.status);
  }

  const isPlaylist = /\.m3u8$/i.test(path);
  const headers = new Headers();
  ["Content-Type", "Content-Length", "Content-Range", "ETag", "Last-Modified", "Accept-Ranges"].forEach((name) => {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  });

  if (isPlaylist) {
    headers.set("Content-Type", "application/vnd.apple.mpegurl");
    /* Playlists carry freshly signed child URLs, so they must not be cached by
       a shared cache. Signed responses are per-token anyway. */
    headers.set("Cache-Control", "private, max-age=0, no-store");
  } else {
    const ttl = Number(env.CACHE_TTL) || 86400;
    headers.set("Cache-Control", "public, max-age=" + ttl + (ttl >= 86400 ? ", immutable" : ""));
  }

  let body = null;
  if (request.method === "GET") {
    if (isPlaylist) {
      const text = await upstream.text();
      body = await rewritePlaylist(text, path, verified.expiresAt || (Math.floor(Date.now() / 1000) + 3600), env.MEDIA_SIGNING_KEY);
      headers.delete("Content-Length");
    } else {
      body = upstream.body;
    }
  }

  const responseHeaders = corsHeaders(env, origin, headers);
  responseHeaders.set("X-Cache", "MISS");
  responseHeaders.set("X-Robots-Tag", "noindex");
  const response = new Response(body, { status: upstream.status, headers: responseHeaders });

  if (store && request.method === "GET" && cacheable(path, rangeHeader) && upstream.status === 200) {
    const toCache = response.clone();
    /* Cache-Control on the stored copy must permit caching. */
    const wait = store.put(cacheKey, toCache).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(wait);
    else await wait;
  }

  return response;
}

const worker = {
  fetch: handleRequest
};

export default worker;

/* Extra exports are ignored by the Workers runtime; they exist so the test
   suite can exercise the real implementation instead of a copy of it. */
export {
  signPath, rewritePlaylist, normalizePath, resolvePath, encodeKey, verifySignature,
  handleRequest, trackRequest, statsRequest, creditSeconds, deviceOf
};
export const __test = { authorize, cacheStore, resetAuth: () => { authCache = null; } };
