/* ============================================================================
   ESMERINGHOY — CDN WORKER TEST SUITE
   ----------------------------------------------------------------------------
   Run:  node worker/b2-cdn-worker.test.mjs

   This drives the *real* Worker handler (no copy, no mocks of the handler) with
   the real fetch API against a local Backblaze B2 stand-in, so what is checked
   here is the code that ships.

   Start the stand-in first (it ships in this repo, no account needed):
     node tools/test-fixture.mjs /tmp/hls      # synthetic ladder, no ffmpeg
     node tools/b2-stand-in.mjs 8090 /tmp/hls
   …or seed nothing and just exercise the signature/authorisation paths: the
   checks that fetch playlist and segment objects (nine of them) need a ladder,
   and report honestly rather than being skipped.

   It covers: signature verification (missing / expired / tampered), the /token
   exchange and its origin allowlist, HLS playlist rewriting including nested
   playlists and EXT-X-MAP, range requests, 404s, traversal attempts, and edge
   caching.

   Exit status is non-zero if any check fails.
   ========================================================================== */

import assert from "node:assert/strict";
import worker, { signPath, normalizePath, verifySignature, creditSeconds, deviceOf } from "./b2-cdn-worker.js";
import { createD1 } from "./d1-stand-in.mjs";

const SIM = process.env.B2_SIM_URL || "http://127.0.0.1:8090";
const SIGNING_KEY = "test-signing-key-do-not-use";
const ORIGIN = "https://esmeringhoy.com";
const PLAYLIST = process.env.B2_TEST_PLAYLIST || "hls/seeded/master.m3u8";

const env = {
  BUCKET_NAME: "esmeringhoy-media",
  B2_KEY_ID: "test-key-id",
  B2_APPLICATION_KEY: "test-app-key",
  MEDIA_SIGNING_KEY: SIGNING_KEY,
  SITE_ORIGINS: ORIGIN,
  TOKEN_TTL: "3600",
  CACHE_TTL: "60",
  B2_API_URL: SIM + "/b2api/v2",
  __cache: null
};

let failures = 0;
let checks = 0;

async function check(name, fn) {
  checks++;
  try {
    await fn();
    console.log("  ok   " + name);
  } catch (err) {
    failures++;
    console.log("  FAIL " + name + "\n       " + String(err.message).split("\n").join("\n       "));
  }
}

/* A Cache API stand-in: enough of match/put/delete to exercise the real paths. */
function fakeCache() {
  const entries = new Map();
  return {
    entries,
    async match(key) {
      const hit = entries.get(typeof key === "string" ? key : key.url);
      return hit ? hit.clone() : null;
    },
    async put(key, response) {
      entries.set(typeof key === "string" ? key : key.url, response.clone());
    },
    async delete(key) {
      return entries.delete(typeof key === "string" ? key : key.url);
    }
  };
}

function call(path, init) {
  return worker.fetch(new Request("https://media.example.com" + path, init), env, {});
}

async function signedPath(path, ttl) {
  const seconds = ttl == null ? 3600 : ttl;
  const expiresAt = Math.floor(Date.now() / 1000) + seconds;
  const signature = await signPath(SIGNING_KEY, path, expiresAt);
  return "/" + path + "?e=" + expiresAt + "&s=" + signature;
}

console.log("\nWorker health");

await check("reports its configuration without leaking secrets", async () => {
  const response = await call("/_health");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.bucket, "esmeringhoy-media");
  assert.equal(body.signing, true);
  const text = JSON.stringify(body);
  assert.ok(!text.includes(SIGNING_KEY), "signing key leaked in /_health");
  assert.ok(!text.includes(env.B2_APPLICATION_KEY), "application key leaked in /_health");
});

console.log("\nToken exchange");

let tokenUrl = null;

await check("issues a signed URL to an allowed origin", async () => {
  const response = await call("/token?p=" + encodeURIComponent(PLAYLIST), { headers: { Origin: ORIGIN } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const body = await response.json();
  tokenUrl = body.url;
  assert.ok(tokenUrl.includes("e=") && tokenUrl.includes("s="), "no signature in the issued URL");

  /* The issued URL must verify for exactly the requested path. */
  const parsed = new URL("https://x" + tokenUrl);
  const verified = await verifySignature(env, normalizePath(parsed.pathname), parsed.searchParams.get("e"), parsed.searchParams.get("s"));
  assert.equal(verified.ok, true, "issued signature does not verify");
});

await check("respects a shorter ttl", async () => {
  const response = await call("/token?p=" + encodeURIComponent(PLAYLIST) + "&ttl=60", { headers: { Origin: ORIGIN } });
  const body = await response.json();
  const seconds = body.expiresAt - Math.floor(Date.now() / 1000);
  assert.ok(seconds > 40 && seconds <= 60, "ttl not honoured: " + seconds);
});

await check("refuses an origin that is not on the list", async () => {
  const response = await call("/token?p=" + encodeURIComponent(PLAYLIST), { headers: { Origin: "https://evil.example" } });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "origin_not_allowed");
});

await check("refuses a token request with no path", async () => {
  const response = await call("/token", { headers: { Origin: ORIGIN } });
  assert.equal(response.status, 400);
});

await check("rejects a traversal path in a token request", async () => {
  const response = await call("/token?p=" + encodeURIComponent("../../etc/passwd"), { headers: { Origin: ORIGIN } });
  assert.equal(response.status, 400);
});

console.log("\nSignature enforcement");

await check("refuses an unsigned request", async () => {
  const response = await call("/" + PLAYLIST);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "missing_expiry");
});

await check("refuses an expired link", async () => {
  const response = await call(await signedPath(PLAYLIST, -60));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "expired");
});

await check("refuses a tampered signature", async () => {
  const good = await signedPath(PLAYLIST);
  const tampered = good.replace(/s=[0-9a-f]+/, "s=" + "0".repeat(64));
  const response = await call(tampered);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "bad_signature");
});

await check("refuses a signature minted for a different file", async () => {
  const forOther = await signedPath("hls/seeded/poster.jpg");
  const signature = new URL("https://x" + forOther).searchParams.get("s");
  const expires = new URL("https://x" + forOther).searchParams.get("e");
  const response = await call("/" + PLAYLIST + "?e=" + expires + "&s=" + signature);
  assert.equal(response.status, 403, "a signature for one path was accepted for another");
});

await check("exposes the security headers a player needs", async () => {
  const response = await call(await signedPath(PLAYLIST), { headers: { Origin: ORIGIN } });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(response.headers.get("Access-Control-Expose-Headers") || "", /Content-Range/i);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex");
});

console.log("\nPlaylist rewriting (this is what makes HLS work)");

let masterBody = null;

await check("serves the master playlist with the right content type", async () => {
  const response = await call(await signedPath(PLAYLIST), { headers: { Origin: ORIGIN } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /mpegurl/);
  assert.match(response.headers.get("Cache-Control") || "", /no-store/);
  masterBody = await response.text();
  assert.ok(masterBody.includes("#EXTM3U"), "not a playlist: " + masterBody.slice(0, 80));
});

await check("signs every variant URL it hands out", async () => {
  const lines = masterBody.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  assert.ok(lines.length >= 2, "expected several variant playlists, got " + lines.length);
  for (const line of lines) {
    assert.match(line, /\?e=\d+&s=[0-9a-f]{64}$/, "variant URL is not signed: " + line);
  }
});

await check("rewritten variant URLs verify for their own resolved path", async () => {
  const variant = masterBody.split("\n").filter((l) => l.trim() && !l.startsWith("#"))[0];
  const parsed = new URL("https://x" + variant);
  const verified = await verifySignature(
    env, normalizePath(parsed.pathname), parsed.searchParams.get("e"), parsed.searchParams.get("s")
  );
  assert.equal(verified.ok, true, "the rewritten variant URL does not verify: " + variant);
  assert.match(parsed.pathname, /^\/hls\/seeded\//, "variant path resolved outside the playlist folder");
});

await check("rewrites nested playlists and the EXT-X-MAP init segment", async () => {
  const variant = masterBody.split("\n").filter((l) => l.trim() && !l.startsWith("#"))[0];
  const variantPath = normalizePath(new URL("https://x" + variant).pathname);
  const response = await call(variant, { headers: { Origin: ORIGIN } });
  assert.equal(response.status, 200);
  const body = await response.text();

  const mapLine = body.split("\n").find((l) => l.startsWith("#EXT-X-MAP"));
  assert.ok(mapLine, "no EXT-X-MAP in the variant playlist");
  assert.match(mapLine, /URI="[^"]+\?e=\d+&s=[0-9a-f]{64}"/, "EXT-X-MAP URI was not signed: " + mapLine);

  /* The rewritten URI must point at the init segment in the same folder — not,
     say, back at this playlist, which still looks 'signed' but plays nothing. */
  const mapUri = /URI="([^"]+)"/.exec(mapLine)[1];
  const mapPath = normalizePath(new URL("https://x" + mapUri).pathname);
  const expectedInit = variantPath.replace(/[^/]+$/, "init_0.mp4");
  assert.equal(mapPath, expectedInit, "EXT-X-MAP points at the wrong object: " + mapPath);

  const segments = body.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  assert.ok(segments.length >= 1, "no segments listed");
  for (const segment of segments) {
    assert.match(segment, /\?e=\d+&s=[0-9a-f]{64}$/, "segment URL is not signed: " + segment);
    /* ...and each one must resolve into the playlist's own folder. */
    const segmentPath = normalizePath(new URL("https://x" + segment).pathname);
    assert.ok(
      segmentPath.startsWith(variantPath.replace(/[^/]+$/, "")),
      "segment escaped its folder: " + segmentPath
    );
  }
  return { body, segments };
});

await check("a segment fetched from a rewritten URL returns video bytes", async () => {
  const variant = masterBody.split("\n").filter((l) => l.trim() && !l.startsWith("#"))[0];
  const variantBody = await (await call(variant)).text();
  const segment = variantBody.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  const response = await call(segment, { headers: { Origin: ORIGIN } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /iso\.segment|octet-stream/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.length > 1000, "segment body looks empty: " + bytes.length);
});

console.log("\nRanges, misses and traversal");

await check("passes a range request through as 206", async () => {
  const response = await call(await signedPath("hls/seeded/poster.jpg"), {
    headers: { Range: "bytes=0-99", Origin: ORIGIN }
  });
  assert.equal(response.status, 206);
  assert.match(response.headers.get("Content-Range") || "", /^bytes 0-99\//);
  assert.ok((await response.arrayBuffer()).byteLength <= 100);
});

await check("returns 404 for a missing object with a useful message", async () => {
  const response = await call(await signedPath("hls/seeded/nope.mp4"));
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error, "not_found");
  assert.equal(body.path, "hls/seeded/nope.mp4");
});

await check("refuses encoded traversal in a media URL", async () => {
  const response = await call("/hls/seeded/%2e%2e/%2e%2e/etc/passwd?e=9999999999&s=" + "0".repeat(64));
  assert.ok(response.status === 403 || response.status === 400, "expected 400/403, got " + response.status);
});

await check("rejects unsupported methods", async () => {
  const response = await call(await signedPath(PLAYLIST), { method: "DELETE" });
  assert.equal(response.status, 405);
});

await check("answers a CORS preflight", async () => {
  const response = await call("/" + PLAYLIST, { method: "OPTIONS", headers: { Origin: ORIGIN } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

console.log("\nEdge caching");

await check("caches segments but never playlists", async () => {
  env.__cache = fakeCache();

  const segmentPath = "hls/seeded/stream_360p/seg_0000.m4s";
  const first = await call(await signedPath(segmentPath));
  assert.equal(first.headers.get("X-Cache"), "MISS");
  await first.arrayBuffer(); /* drain so the clone in put() is complete */

  const second = await call(await signedPath(segmentPath));
  assert.equal(second.headers.get("X-Cache"), "HIT", "segment was not served from cache");
  assert.equal(env.__cache.entries.size, 1, "unexpected cache entries: " + env.__cache.entries.size);

  const playlist = await call(await signedPath(PLAYLIST));
  assert.equal(playlist.headers.get("X-Cache"), "MISS");
  assert.equal(env.__cache.entries.size, 1, "a playlist was written to the cache");

  env.__cache = null;
});

await check("a cached segment still verifies the signature first", async () => {
  env.__cache = fakeCache();
  const segmentPath = "hls/seeded/stream_360p/seg_0000.m4s";
  await (await call(await signedPath(segmentPath))).arrayBuffer();

  const forged = await call("/" + segmentPath + "?e=9999999999&s=" + "1".repeat(64));
  assert.equal(forged.status, 403, "a forged request was served from cache");
  env.__cache = null;
});

console.log("\nPrivate bucket behaviour");

await check("the sim really is private (a direct anonymous fetch fails)", async () => {
  const direct = await fetch(SIM + "/file/esmeringhoy-media/" + PLAYLIST);
  assert.equal(direct.status, 401, "the stand-in bucket is not enforcing auth");
});

await check("the worker authenticates to the bucket and gets the file", async () => {
  const response = await call(await signedPath(PLAYLIST));
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes("#EXTM3U"));
});

/* ============================================================================
   STATISTICS
   ----------------------------------------------------------------------------
   The Worker's statistics SQL runs against a real SQLite database through
   worker/d1-stand-in.mjs, and the clock is driven by hand so watch time can be
   checked over a simulated minute of playback instead of a real one.
   ========================================================================== */

console.log("\nStatistics — reporting");

const STATS_TOKEN = "stats-token-for-tests";
const statsEnv = Object.assign({}, env, {
  DB: createD1(),
  STATS_TOKEN: STATS_TOKEN,
  SITE_ORIGINS: ORIGIN + ",null"
});

delete statsEnv.__cache;

let pendingWrites = [];

function statsCall(path, init) {
  return worker.fetch(
    new Request("https://media.example.com" + path, init),
    statsEnv,
    { waitUntil: (promise) => pendingWrites.push(Promise.resolve(promise)) }
  );
}

/* ctx.waitUntil means the response returns before the row is written; the test
   waits for the writes the same way the runtime would. */
async function flush() {
  const writes = pendingWrites;
  pendingWrites = [];
  await Promise.all(writes);
}

async function rows() {
  await flush();
  return statsEnv.DB.__rows("SELECT * FROM play_sessions ORDER BY started_at, id");
}

/* A clock the test owns, so "15 seconds of playback" is not a real 15 seconds. */
let clock = Date.now();
const realDateNow = Date.now;
Date.now = () => clock;

function advance(seconds) {
  clock += seconds * 1000;
}

async function track(body, options) {
  const opts = options || {};
  const key = body.path;
  const payload = Object.assign({}, body);
  if (!opts.noExpiry) {
    const expiresAt = Math.floor(Date.now() / 1000) + (opts.ttl == null ? 3600 : opts.ttl);
    payload.exp = expiresAt;
    if (!opts.unsigned) payload.sig = await signPath(SIGNING_KEY, key, expiresAt);
  }
  const headers = {
    "Content-Type": "text/plain;charset=UTF-8",
    "CF-Connecting-IP": opts.ip || "203.0.113.7",
    "User-Agent": opts.ua || "Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/131.0"
  };
  if (opts.origin !== null) headers.Origin = opts.origin || ORIGIN;
  return statsCall("/track", { method: "POST", headers: headers, body: JSON.stringify(payload) });
}

/* The clip the rest of this suite plays, so the paths line up with real media. */
const CLIP = PLAYLIST.replace(/\/[^/]+$/, "/stream_360p/index.m3u8");

await check("refuses a beacon with no signature at all", async () => {
  const unsigned = await track({ session: "a1b2c3d4e5f6", path: CLIP, event: "start", position: 2, playing: true }, { noExpiry: true });
  assert.equal(unsigned.status, 403);
  assert.equal((await unsigned.json()).error, "missing_expiry");

  const wrongSignature = await track({ session: "a1b2c3d4e5f6", path: CLIP, event: "start", position: 2, playing: true }, { unsigned: true });
  assert.equal(wrongSignature.status, 403);
  assert.equal((await wrongSignature.json()).error, "bad_signature");
});

await check("refuses a beacon signed for a different clip", async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const foreign = await signPath(SIGNING_KEY, "hls/somewhere/else.mp4", expiresAt);
  const response = await statsCall("/track", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
    body: JSON.stringify({ session: "a1b2c3d4e5f6", path: CLIP, exp: expiresAt, sig: foreign, event: "start", playing: true, position: 2 })
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "bad_signature");
});

await check("refuses a beacon from an origin that is not the site", async () => {
  const response = await track(
    { session: "a1b2c3d4e5f6", path: CLIP, event: "start", position: 2, playing: true },
    { origin: "https://evil.example" }
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "origin_not_allowed");
});

await check("refuses a malformed session id or body", async () => {
  const bad = await track({ session: "x", path: CLIP, event: "start", position: 2, playing: true });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "bad_session");

  const empty = await statsCall("/track", { method: "POST", headers: { Origin: ORIGIN }, body: "not json" });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "bad_body");
});

await check("refuses a GET on /track", async () => {
  const response = await statsCall("/track");
  assert.equal(response.status, 405);
});

await check("a session that never played is not a view", async () => {
  const response = await track({ session: "bouncebounce", path: CLIP, event: "progress", position: 0, playing: false });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stored, false);
  assert.equal(body.reason, "not_playing");
  /* Nothing has been written yet: not the rejected beacons, not this one. */
  assert.equal((await rows()).length, 0);
});

await check("a played session is recorded as one view", async () => {
  const response = await track({ session: "sess-first-view", path: CLIP, event: "start", position: 2, duration: 60, playing: true });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stored, true);
  assert.equal(body.counted, "view");

  const stored = await rows();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].key, CLIP);
  assert.equal(stored[0].watched_seconds, 0, "a fresh session starts at zero watch time");
  assert.equal(stored[0].device, "desktop");
  assert.ok(stored[0].viewer, "no viewer hash was stored");
  assert.ok(!/^\d{1,3}\.\d{1,3}\./.test(String(stored[0].viewer)), "an IP address was stored verbatim");
});

await check("the same session twice is still one view", async () => {
  const response = await track({ session: "sess-first-view", path: CLIP, event: "start", position: 2, duration: 60, playing: true });
  assert.equal(response.status, 200);
  const stored = await rows();
  assert.equal(stored.length, 1, "a repeated start created a second view");
  assert.equal(stored[0].started_at, stored[0].last_seen_at);
  /* One second has passed, so at most one second plus slack can be credited —
     a repeated report is not worth a second helping of the same playback. */
  assert.ok(stored[0].watched_seconds <= 3,
    "a repeated start credited " + stored[0].watched_seconds + "s");
});

await check("watch time is credited from forward progress, not from claims", async () => {
  /* 15 real seconds of playback, reported as the player reports it. */
  advance(15);
  const honest = await track({ session: "sess-first-view", path: CLIP, event: "progress", position: 17, duration: 60, playing: true });
  const honestBody = await honest.json();
  assert.ok(honestBody.creditedSeconds >= 15 && honestBody.creditedSeconds <= 17,
    "15s of playback credited " + honestBody.creditedSeconds + "s");

  /* A forged claim one second later: "I watched 59 minutes". The cap is the wall
     clock since the previous report, so this must earn almost nothing. */
  advance(1);
  const forged = await track({ session: "sess-first-view", path: CLIP, event: "progress", position: 3599, duration: 60, playing: true });
  const forgedBody = await forged.json();
  assert.ok(forgedBody.creditedSeconds <= 3,
    "a forged 1-hour jump earned " + forgedBody.creditedSeconds + "s of watch time");
  assert.ok(forgedBody.watchedSeconds > 15, "the honest 15s was lost");
  assert.ok(forgedBody.watchedSeconds <= 20,
    "watch time outran real time: " + forgedBody.watchedSeconds + "s in 16s of session");
});

await check("replaying a stretch counts again, at real-time pace", async () => {
  /* The clip has run to the end, the viewer seeks back and watches it again. */
  const clip = "clips/replayed.mp4";
  await track({ session: "sess-replay", path: clip, event: "start", position: 2, duration: 10, playing: true });
  /* Eight seconds of content played over eight seconds of wall clock — the cap
     credits what really elapsed, so the clock must keep pace with the claim. */
  advance(8);
  await track({ session: "sess-replay", path: clip, event: "end", position: 10, duration: 10, playing: true });

  const first = (await rows()).find((row) => row.id === "sess-replay");
  const firstPass = first.watched_seconds;
  assert.ok(firstPass >= 10 && firstPass <= 12, "first pass credited " + firstPass + "s");

  /* Seek back to 0 and play the whole thing again: another 10 real seconds. */
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  await statsCall("/track", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "text/plain", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify({ session: "sess-replay", path: clip, exp: expiresAt,
      sig: await signPath(SIGNING_KEY, clip, expiresAt), event: "progress", position: 1, duration: 10, playing: true })
  });
  advance(9);
  const replay = await track({ session: "sess-replay", path: clip, event: "end", position: 10, duration: 10, playing: true });
  const replayBody = await replay.json();
  assert.ok(replayBody.creditedSeconds >= 8, "the replay credited only " + replayBody.creditedSeconds + "s");
  assert.ok(replayBody.watchedSeconds >= firstPass + 8,
    "a rewatch was not counted: " + replayBody.watchedSeconds + "s total");

  /* This check is about credit mechanics, but later checks count the total
     sessions in the shared database — so its fixture must not outlive it. */
  await statsEnv.DB.exec("DELETE FROM play_sessions WHERE id = 'sess-replay'");
});

await check("seeking backwards credits nothing", async () => {
  const response = await track({ session: "sess-first-view", path: CLIP, event: "progress", position: 5, duration: 60, playing: true });
  const body = await response.json();
  assert.equal(body.creditedSeconds, 0);
});

await check("a paused heartbeat credits nothing but is still recorded", async () => {
  advance(30);
  const response = await track({ session: "sess-first-view", path: CLIP, event: "progress", position: 30, duration: 60, playing: false });
  const body = await response.json();
  assert.equal(body.creditedSeconds, 0);
  const stored = await rows();
  /* One row, one view: the six beacons sent so far each incremented `events`
     rather than inserting a session. */
  assert.equal(stored.length, 1);
  assert.equal(stored[0].events, 6);
  assert.ok(stored[0].last_seen_at > stored[0].started_at, "last_seen_at was never updated");
});

await check("the end event marks the session finished", async () => {
  const response = await track({ session: "sess-first-view", path: CLIP, event: "end", position: 60, duration: 60, playing: false });
  const body = await response.json();
  assert.equal(body.completed, true);
  const stored = await rows();
  assert.equal(stored[0].completed, 1);
  assert.equal(stored[0].duration, 60);
});

await check("a second clip and a second viewer are counted separately", async () => {
  advance(20);
  await track({ session: "sess-other-clip", path: "clips/other.mp4", event: "start", position: 3, duration: 300, playing: true }, { ip: "198.51.100.9", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari" });
  advance(5);
  await track({ session: "sess-same-viewer", path: CLIP, event: "start", position: 2, duration: 60, playing: true });

  const stored = await rows();
  assert.equal(stored.length, 3, "expected three sessions, got " + stored.length);
  const others = stored.filter((row) => row.id === "sess-other-clip");
  assert.equal(others.length, 1);
  assert.equal(others[0].device, "phone");

  /* Same IP, same day: the two sessions must share a viewer hash. */
  const sameIp = stored.filter((row) => row.key === CLIP);
  assert.equal(new Set(sameIp.map((row) => row.viewer)).size, 1, "one viewer became two");
  assert.notEqual(others[0].viewer, sameIp[0].viewer, "two viewers became one");
});

await check("tracking can be switched off without breaking playback", async () => {
  statsEnv.TRACKING = "off";
  try {
    const response = await track({ session: "sess-ignored-one", path: CLIP, event: "start", position: 2, playing: true });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.stored, false);
    assert.equal(body.reason, "tracking_disabled");
    assert.equal((await rows()).length, 3);
  } finally {
    /* Restore even if an assertion fails here: leaving TRACKING=off would make
       every later beacon silently no-op and cascade into unrelated checks. */
    delete statsEnv.TRACKING;
  }
});

await check("a Worker with no database still answers beacons", async () => {
  /* The deployment in the earlier sections has no DB bound. */
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const response = await worker.fetch(new Request("https://media.example.com/track", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
    body: JSON.stringify({
      session: "sess-no-database", path: PLAYLIST, event: "start", position: 2, playing: true,
      exp: expiresAt, sig: await signPath(SIGNING_KEY, PLAYLIST, expiresAt)
    })
  }), env, { waitUntil: () => {} });
  assert.equal(response.status, 200, "a missing database broke the player's heartbeat");
  const body = await response.json();
  assert.equal(body.stored, false);
  assert.equal(body.reason, "no_database");
  assert.ok(Array.isArray(body.setup), "no setup guidance was returned");
});

console.log("\nStatistics — the watch-time ceiling and device detection (unit)");

await check("the credit cap allows real playback and stops inflated claims", () => {
  const row = { started_at: 1000, last_seen_at: 1000, position: 0, watched_seconds: 0 };
  /* 15 seconds of playback reported 15 seconds later is exactly what happened. */
  assert.equal(creditSeconds(row, { position: 15, playing: true }, 1015), 15);
  /* An hour-long claim one second after the last report is worth one second
     plus slack, not an hour. */
  assert.equal(creditSeconds(row, { position: 3600, playing: true }, 1001), 3);
  /* A paused heartbeat earns nothing at all. */
  assert.equal(creditSeconds(row, { position: 900, playing: false }, 1900), 0);
  /* The same stretch of playback cannot be paid for twice. */
  const used = { started_at: 1000, last_seen_at: 1015, position: 15, watched_seconds: 15 };
  assert.equal(creditSeconds(used, { position: 15, playing: true }, 1015), 0);
  /* Seeking backwards earns nothing by itself... */
  assert.equal(creditSeconds(used, { position: 4, playing: true }, 1020), 0);
  /* ...but watching forward again from there does, at real-time pace. */
  assert.equal(creditSeconds({ started_at: 1000, last_seen_at: 1020, position: 4, watched_seconds: 15 },
    { position: 10, playing: true }, 1026), 6);
  assert.equal(creditSeconds(null, { position: 15, playing: true }, 1015), 0);
});

await check("devices are classified from a user agent", () => {
  assert.equal(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148"), "phone");
  assert.equal(deviceOf("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), "tablet");
  assert.equal(deviceOf("Roku/DVP-12.5 (0512.50E04124A)"), "tv");
  assert.equal(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "desktop");
  assert.equal(deviceOf(""), null);
});

console.log("\nStatistics — reporting to the admin panel");

await check("refuses /stats without the right password", async () => {
  const none = await statsCall("/stats", { headers: { Origin: ORIGIN } });
  assert.equal(none.status, 401);
  assert.equal((await none.json()).error, "unauthorized");

  const wrong = await statsCall("/stats", { headers: { Origin: ORIGIN, Authorization: "Bearer " + "0".repeat(STATS_TOKEN.length) } });
  assert.equal(wrong.status, 401, "a same-length wrong token was accepted");
});

await check("says how to switch statistics on when no token is set", async () => {
  const bare = Object.assign({}, statsEnv);
  delete bare.STATS_TOKEN;
  const response = await worker.fetch(new Request("https://media.example.com/stats", { headers: { Origin: ORIGIN } }), bare, {});
  assert.equal(response.status, 501);
  const body = await response.json();
  assert.equal(body.setupRequired, true);
  assert.ok(body.steps.join(" ").includes("D1"), "the guidance does not mention D1");
  assert.ok(body.steps.join(" ").includes("STATS_TOKEN"), "the guidance does not mention STATS_TOKEN");
});

await check("says how to bind a database when none is bound", async () => {
  const bare = Object.assign({}, statsEnv);
  delete bare.DB;
  const response = await worker.fetch(
    new Request("https://media.example.com/stats", { headers: { Authorization: "Bearer " + STATS_TOKEN, Origin: ORIGIN } }),
    bare, {}
  );
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error, "no_database");
});

await check("refuses /stats from an origin that is not the site", async () => {
  const response = await statsCall("/stats", { headers: { Authorization: "Bearer " + STATS_TOKEN, Origin: "https://evil.example" } });
  assert.equal(response.status, 403);
});

await check("allows the file:// admin panel (Origin: null) when listed", async () => {
  const response = await statsCall("/stats", { headers: { Authorization: "Bearer " + STATS_TOKEN, Origin: "null" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

await check("returns the aggregates the panel renders", async () => {
  const response = await statsCall("/stats?days=7", { headers: { Authorization: "Bearer " + STATS_TOKEN, Origin: ORIGIN } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control") || "", /no-store/, "statistics must never be cached");

  const body = await response.json();
  assert.equal(body.totals.views, 3, "totals should count three sessions, saw " + body.totals.views);
  assert.equal(body.totals.completions, 1);
  assert.equal(body.totals.uniqueViewers, 2, "expected two viewers, saw " + body.totals.uniqueViewers);
  assert.ok(body.totals.watchSeconds > 0, "no watch time was aggregated");
  assert.ok(body.totals.watchSeconds < 3600, "watch time is implausible: " + body.totals.watchSeconds);
  assert.equal(body.totals.watchSeconds, Math.round(body.totals.watchSeconds * 10) / 10,
    "watch time is not reported to one decimal place");

  assert.equal(body.clips.length, 2, "expected two clips, saw " + body.clips.length);
  const busy = body.clips[0];
  assert.equal(busy.key, CLIP, "clips are not ordered by views");
  assert.equal(busy.views, 2);
  assert.equal(busy.completions, 1);
  assert.equal(busy.uniqueViewers, 1, "two sessions from one IP should read as one viewer");

  assert.ok(Array.isArray(body.daily) && body.daily.length >= 1, "no daily series");
  assert.match(body.daily[0].day, /^\d{4}-\d{2}-\d{2}$/, "daily buckets are not dates: " + body.daily[0].day);
  assert.equal(body.daily.reduce((sum, d) => sum + d.views, 0), 3, "daily buckets do not add up to the total");

  const devices = body.totals.devices.map((d) => d.device).sort();
  assert.deepEqual(devices, ["desktop", "phone"], "device breakdown is wrong: " + devices.join(","));
});

await check("narrows to one clip and to a range", async () => {
  const one = await statsCall("/stats?days=7&key=" + encodeURIComponent(CLIP), { headers: { Authorization: "Bearer " + STATS_TOKEN, Origin: ORIGIN } });
  const body = await one.json();
  assert.equal(body.clips.length, 1);
  assert.equal(body.totals.views, 2);

  /* Nothing was viewed before the clock's day-1 edge here, so a 0-day window
     must be treated as "all time" rather than "nothing". */
  const all = await statsCall("/stats", { headers: { Authorization: "Bearer " + STATS_TOKEN, Origin: ORIGIN } });
  const allBody = await all.json();
  assert.equal(allBody.range.days, null);
  assert.equal(allBody.totals.views, 3);

  /* A window in the future returns zeros rather than an error. */
  const none = await statsCall("/stats?days=7&key=" + encodeURIComponent("clips/nothing-here.mp4"), { headers: { Authorization: "Bearer " + STATS_TOKEN, Origin: ORIGIN } });
  const noneBody = await none.json();
  assert.equal(noneBody.totals.views, 0);
  assert.equal(noneBody.totals.avgSeconds, 0);
  assert.deepEqual(noneBody.clips, []);
});

await check("accepts the password in a query string too", async () => {
  const response = await statsCall("/stats?token=" + encodeURIComponent(STATS_TOKEN), { headers: { Origin: ORIGIN } });
  assert.equal(response.status, 200);
});

await check("a pause flush earns the seconds that were really watched", async () => {
  const clip = "clips/pause-flush.mp4";
  await track({ session: "sess-pause-flush", path: clip, event: "start", position: 2, duration: 60, playing: true }, { ip: "203.0.113.30" });
  advance(4);
  /* The player pauses at 6s and says the position was played, which is true. */
  const paused = await track({ session: "sess-pause-flush", path: clip, event: "progress", position: 6, duration: 60, playing: true }, { ip: "203.0.113.30" });
  const body = await paused.json();
  assert.ok(body.creditedSeconds >= 4 && body.creditedSeconds <= 6,
    "a 4-second playback credited " + body.creditedSeconds + "s");

  /* The same report claiming the position was reached while paused earns the
     benefit of the doubt only up to the wall-clock ceiling — which is 0 here,
     because nothing has elapsed since the last credit. */
  advance(0);
  const idle = await track({ session: "sess-pause-flush", path: clip, event: "progress", position: 60, duration: 60, playing: false }, { ip: "203.0.113.30" });
  const idleBody = await idle.json();
  assert.equal(idleBody.creditedSeconds, 0, "an idle claim earned watch time");
});

await check("counts viewers from a proxy header when Cloudflare's is absent", async () => {
  const clip = "clips/behind-a-proxy.mp4";

  async function proxied(session) {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return statsCall("/track", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "text/plain",
        "X-Forwarded-For": "198.51.100.77, 10.0.0.1"
      },
      body: JSON.stringify({
        session: session, path: clip, exp: expiresAt,
        sig: await signPath(SIGNING_KEY, clip, expiresAt), event: "start", position: 2, playing: true
      })
    });
  }

  assert.equal((await proxied("sess-proxied-one")).status, 200);
  advance(3);
  assert.equal((await proxied("sess-proxied-two")).status, 200);

  const stored = (await rows()).filter((row) => row.key === clip);
  assert.equal(stored.length, 2, "the proxied beacons were not stored");
  assert.ok(stored[0].viewer, "no viewer was identified from X-Forwarded-For");
  assert.equal(stored[0].viewer, stored[1].viewer, "one proxied viewer became two");
});

await check("an unknown clip key is not silently matched to another", async () => {
  await track({ session: "sess-unknown-key", path: "clips/renamed-later.mp4", event: "start", position: 4, playing: true }, { ip: "192.0.2.44" });
  const response = await statsCall("/stats", { headers: { Authorization: "Bearer " + STATS_TOKEN, Origin: ORIGIN } });
  const body = await response.json();
  const keys = body.clips.map((clip) => clip.key);
  assert.ok(keys.includes("clips/renamed-later.mp4"), "the new key never appeared: " + keys.join(","));
  assert.equal(new Set(keys).size, keys.length, "a key was double-counted");
});

await check("a traversal path is refused before it is written", async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const response = await statsCall("/track", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
    body: JSON.stringify({
      session: "sess-traversal", path: "../../etc/passwd", exp: expiresAt,
      sig: await signPath(SIGNING_KEY, "../../etc/passwd", expiresAt), event: "start", position: 1, playing: true
    })
  });
  assert.equal(response.status, 400);
  const stored = await rows();
  assert.ok(!stored.some((row) => row.key.includes("passwd")), "a traversal key reached the database");
});

Date.now = realDateNow;

console.log("\nStatic assets beside the API");

/* The deploy shape: site files uploaded next to the Worker. An asset hit is
   served; anything else falls through to the media/signature path.

   This deliberately has no "/" entry: with html_handling = "none" the real
   asset server matches names exactly, so "/" and "/player" are misses that the
   Worker has to resolve. The lookups are recorded so the resolution can be
   asserted rather than inferred from a 200. */
function fakeAssets(files) {
  const seen = [];
  return {
    seen,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push(url.pathname + url.search);
      const file = files[url.pathname];
      if (!file) return new Response("no such asset", { status: 404 });
      return new Response(file.body, { status: 200, headers: { "Content-Type": file.type } });
    }
  };
}

const assetsEnv = Object.assign({}, env, {
  ASSETS: fakeAssets({
    "/index.html": { body: "<!doctype html><title>home</title>", type: "text/html; charset=utf-8" },
    "/player.html": { body: "<!doctype html><title>player</title>", type: "text/html; charset=utf-8" },
    "/admin.html": { body: "<!doctype html><title>admin</title>", type: "text/html; charset=utf-8" }
  })
});

await check("serves the static site beside the API routes", async () => {
  const home = await worker.fetch(new Request("https://media.example.com/"), assetsEnv, {});
  assert.equal(home.status, 200);
  assert.match(home.headers.get("Content-Type") || "", /text\/html/);
  assert.match(await home.text(), /home/);

  const admin = await worker.fetch(new Request("https://media.example.com/admin.html"), assetsEnv, {});
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /admin/);
});

await check("resolves the extensionless form of a page, query string intact", async () => {
  const pretty = await worker.fetch(new Request("https://media.example.com/player?id=7"), assetsEnv, {});
  assert.equal(pretty.status, 200, "status " + pretty.status);
  assert.match(await pretty.text(), /player/);
  assert.ok(
    assetsEnv.ASSETS.seen.includes("/player.html?id=7"),
    "the .html lookup dropped the query: " + assetsEnv.ASSETS.seen.join(", ")
  );

  /* And a miss stays a miss: nothing is invented for a path with no file. */
  const missing = await worker.fetch(new Request("https://media.example.com/nope-page"), assetsEnv, {});
  assert.notEqual(missing.status, 200, "a missing page answered " + missing.status);
});

await check("a signed media URL falls through the assets to the signature check", async () => {
  /* The asset store has no such file, so the request must reach the media
     path: unsigned it is refused, signed it fetches from the bucket. */
  const unsigned = await worker.fetch(new Request("https://media.example.com/" + PLAYLIST), assetsEnv, {});
  assert.equal(unsigned.status, 403, "an unsigned media path was served from assets");

  const signed = await worker.fetch(new Request("https://media.example.com" + await signedPath(PLAYLIST)), assetsEnv, {});
  assert.equal(signed.status, 200, "a signed media URL stopped reaching the bucket");
});

console.log("\n" + (failures ? "FAILED" : "PASSED") + " — " + (checks - failures) + "/" + checks + " checks\n");
process.exit(failures ? 1 : 0);
