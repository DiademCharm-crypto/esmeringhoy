/* ============================================================================
   ESMERINGHOY — BACKBLAZE B2 PREFLIGHT
   ----------------------------------------------------------------------------
   Answers one question before anything else is attempted: are these keys, this
   bucket and this region actually ready for the pipeline? Every prerequisite is
   exercised the way the real code exercises it — the same presignature the
   admin panel and tools/b2-upload.mjs produce, the same native fetch the CDN
   Worker makes — so a pass here means the next steps cannot fail for a reason
   listed below.

   Every prerequisite is checked, and the two negative probes matter as much
   as the positive ones: a forged signature and an expired one must both be
   refused. An endpoint that answered 200 to either would make a green run
   meaningless, because nothing would be guarding the media at all.

   Usage:
     B2_KEY_ID=... B2_APPLICATION_KEY=... B2_BUCKET=my-bucket B2_REGION=us-west-004 \
       node tools/b2-check.mjs

   Options:
     --prefix PATH      Key prefix for the throwaway probe object
                        (default: esmeringhoy-probe/)
     --region REGION    B2 cluster, e.g. us-west-004 (or B2_REGION)
     --endpoint URL     S3 endpoint override (or B2_S3_ENDPOINT)
     --api-url URL      Native API root override (or B2_API_URL)
     --download-url URL Native download root override (or B2_DOWNLOAD_URL)
     --keep             Leave the probe object in the bucket
     --help

   It writes one small text object under the probe prefix and removes it again
   at the end, which is the only way to prove the write path really works.
   Point --endpoint and --api-url at the local stand-in to dry-run the whole
   thing without an account:

     node tools/b2-stand-in.mjs 8090 &
     B2_KEY_ID=test-key-id B2_APPLICATION_KEY=test-app-key \
       B2_BUCKET=esmeringhoy-media B2_REGION=us-west-004 \
       B2_API_URL=http://127.0.0.1:8090/b2api/v2 \
       node tools/b2-check.mjs --endpoint http://127.0.0.1:8090

   Exit status is non-zero if any check fails.
   ========================================================================== */

import { createRequire } from "node:module";
import crypto from "node:crypto";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const SigV4 = require("../signv4.js");

const { values: options } = parseArgs({
  args: process.argv.slice(2),
  options: {
    prefix: { type: "string" },
    region: { type: "string" },
    endpoint: { type: "string" },
    "api-url": { type: "string" },
    "download-url": { type: "string" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false }
  },
  allowPositionals: false
});

if (options.help) {
  console.log("See the header of tools/b2-check.mjs for usage.");
  process.exit(0);
}

const keyId = process.env.B2_KEY_ID;
const appKey = process.env.B2_APPLICATION_KEY;
const bucket = process.env.B2_BUCKET;
let region = options.region || process.env.B2_REGION;

const apiRoot = (options["api-url"] || process.env.B2_API_URL || "https://api.backblazeb2.com/b2api/v2")
  .replace(/\/+$/, "");
const endpoint = (options.endpoint || process.env.B2_S3_ENDPOINT ||
  (region ? `https://s3.${region}.backblazeb2.com` : "")).replace(/\/+$/, "");
const prefix = (options.prefix || "esmeringhoy-probe/").replace(/^\/+/, "");

/* Fatal errors are thrown and reported through exitCode rather than
   process.exit(): exiting while the HTTP sockets are still closing trips a
   libuv assertion on Windows and reports a bogus status for a clean run. */
class FatalError extends Error {}

process.on("uncaughtException", (err) => {
  console.error("\x1b[31merror:\x1b[0m " + (err && err.message ? err.message : err));
  if (process.env.DEBUG) console.error(err && err.stack);
  process.exitCode = 1;
});

function die(message) {
  throw new FatalError(message);
}

if (!keyId || !appKey) {
  die("set B2_KEY_ID and B2_APPLICATION_KEY (an application key, not your account password).");
}
if (!bucket) die("set B2_BUCKET (the bucket name).");
if (!region && !endpoint) {
  die("set B2_REGION (e.g. us-west-004) or --endpoint, to check the upload path.");
}
if (!region) {
  /* Derive the signing region from a Backblaze-shaped endpoint. */
  const match = /s3\.([a-z]{2}-[a-z]+-\d{3})\.backblazeb2\.com/.exec(endpoint);
  if (!match) die("could not read the region out of --endpoint; pass --region too.");
  region = match[1];
}
if (region && !/^[a-z]{2}-[a-z]+-\d{3}$/.test(region) && !options.endpoint) {
  die(`B2_REGION looks wrong: ${JSON.stringify(region)}. It is the cluster name from the bucket's ` +
    "S3 endpoint, e.g. us-west-004 or eu-central-003.");
}

/* ---------------------------------------------------------------- reporting */

let failures = 0;
let checks = 0;
const skipped = [];

async function check(name, fn) {
  checks++;
  try {
    const note = await fn();
    console.log("  ok   " + name + (note ? "  (" + note + ")" : ""));
    return true;
  } catch (err) {
    failures++;
    console.log("  FAIL " + name + "\n       " + String(err && err.message || err).split("\n").join("\n       "));
    return false;
  }
}

function skip(name, why) {
  skipped.push(name);
  console.log("  skip " + name + "  (" + why + ")");
}

function expect(actual, want, what) {
  if (actual !== want) throw new Error(`${what}: expected ${want}, got ${actual}`);
}

/* ------------------------------------------------------------------ helpers */

const probeKey = `${prefix}check-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.txt`;
const probeBody = "esmeringhoy preflight probe " + crypto.randomBytes(12).toString("hex") + "\n";
const probeHash = crypto.createHash("sha256").update(probeBody).digest("hex");

function sha256(bufferOrText) {
  return crypto.createHash("sha256").update(bufferOrText).digest("hex");
}

function presign(method, key, extra) {
  return SigV4.presignUrl(Object.assign({
    method,
    endpoint,
    bucket,
    key,
    region,
    accessKeyId: keyId,
    secretAccessKey: appKey,
    expiresIn: 3600
  }, extra || {}));
}

async function nativeCall(path, headers) {
  const response = await fetch(downloadUrl + path, { headers: headers || {} });
  const body = await response.arrayBuffer();
  return { response, body: Buffer.from(body) };
}

function nativeUrl(key) {
  const encoded = String(key).split("/").map(encodeURIComponent).join("/");
  return "/file/" + encodeURIComponent(bucket) + "/" + encoded;
}

/* --------------------------------------------------------------- B2 native */

console.log("\nKey, bucket and region");
console.log("  key     " + keyId.slice(0, 6) + "…");
console.log("  bucket  " + bucket);
console.log("  region  " + (region || "(unset)") + "  endpoint " + (endpoint || "(none)"));

let authorization = null;

await check("b2_authorize_account accepts the key pair", async () => {
  const response = await fetch(apiRoot + "/b2_authorize_account", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${keyId}:${appKey}`).toString("base64") }
  });

  if (response.status === 401) {
    throw new Error("Backblaze rejected the pair. B2_KEY_ID must be the key *ID* (not the account id) " +
      "and B2_APPLICATION_KEY the key itself — check for a trailing space when pasting.");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  authorization = await response.json();
  const allowed = authorization.allowed || {};
  if (allowed.bucketName && allowed.bucketName !== bucket) {
    throw new Error(`this key is scoped to bucket ${JSON.stringify(allowed.bucketName)}, not ` +
      `${JSON.stringify(bucket)} — one of the two is wrong`);
  }
  return "token ok" + (allowed.capabilities ? ", " + allowed.capabilities.join("/") : "");
});

const downloadUrl = (options["download-url"] || process.env.B2_DOWNLOAD_URL ||
  (authorization && authorization.downloadUrl) || "").replace(/\/+$/, "");

/* Native API calls go to the configured root, or to the cluster's apiUrl with
   B2's version segment appended — b2_authorize_account hands back a bare host
   (https://api004.backblazeb2.com), and the endpoints hang off /b2api/v2/. */
function nativeApiBase() {
  if (options["api-url"] || process.env.B2_API_URL) return apiRoot;
  const cluster = authorization && authorization.apiUrl;
  return cluster ? cluster.replace(/\/+$/, "") + "/b2api/v2" : apiRoot;
}

await check("b2_list_buckets reports the bucket with the S3 API enabled", async () => {
  if (!authorization) throw new Error("no authorization token (the previous check failed)");

  const response = await fetch(nativeApiBase() + "/b2_list_buckets", {
    method: "POST",
    headers: { Authorization: authorization.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: authorization.accountId, bucketName: bucket })
  });

  if (response.status === 401 || response.status === 403) {
    /* A key scoped to one bucket usually cannot list buckets; that is expected
       and not a problem, so this check reports itself as skipped instead. */
    checks--;
    skip("bucket settings", "the key cannot list buckets (listBuckets capability)");
    return;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);

  const listed = await response.json();
  const found = (listed.buckets || []).find((b) => b.bucketName === bucket);
  if (!found) throw new Error(`bucket ${JSON.stringify(bucket)} is not in this account`);

  const notes = [];
  if (!(found.options || []).includes("s3")) {
    throw new Error('the bucket has no "s3" option, so presigned uploads from a browser or ' +
      "tools/b2-upload.mjs will be refused. Enable it in the B2 console (Bucket Settings → " +
      "S3-compatible API) or run tools/b2-setup.mjs.");
  }
  notes.push("s3 enabled");

  const cors = found.corsRules || [];
  const uploadRule = cors.find((rule) => (rule.allowedOperations || []).includes("s3_put"));
  if (!uploadRule) {
    notes.push("no CORS rule allows s3_put — the CLI upload works, the admin panel cannot");
  } else {
    notes.push("CORS put from " + (uploadRule.allowedOrigins || []).join(", "));
  }

  return notes.join(", ");
});

/* --------------------------------------------------------------- S3 upload */

console.log("\nUpload path (presigned, what tools/b2-upload.mjs and the admin panel use)");

const putWorked = await check("a presigned PUT stores the probe object", async () => {
  const signed = await presign("PUT", probeKey);
  const response = await fetch(signed.url, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: probeBody
  });

  if (response.status === 403 && /AccessDenied/i.test(await response.clone().text().catch(() => ""))) {
    throw new Error("the key cannot write to this bucket. A read-only key uploads nothing — use a key " +
      "with the writeFiles capability (the admin panel and b2-upload.mjs both need it).");
  }
  expect(response.status, 200, "PUT status");
  return "stored " + probeKey;
});

await check("a presigned GET returns the same bytes", async () => {
  if (!putWorked) throw new Error("nothing was stored, so there is nothing to read");

  const signed = await presign("GET", probeKey);
  const response = await fetch(signed.url);
  expect(response.status, 200, "GET status");

  const received = Buffer.from(await response.arrayBuffer());
  if (sha256(received) !== probeHash) {
    throw new Error("the object read back is not what was written");
  }
  return received.length + " bytes, sha256 matches";
});

await check("a Range GET answers 206 with the requested bytes (seeking)", async () => {
  if (!putWorked) throw new Error("nothing was stored, so there is nothing to read");

  const signed = await presign("GET", probeKey);
  const response = await fetch(signed.url, { headers: { Range: "bytes=0-2" } });
  expect(response.status, 206, "range status");
  expect(response.headers.get("content-range"), "bytes 0-2/" + Buffer.byteLength(probeBody), "content-range");

  const received = Buffer.from(await response.arrayBuffer());
  if (received.length !== 3 || received.toString() !== probeBody.slice(0, 3)) {
    throw new Error("the range response did not contain the requested bytes");
  }
  return "206, 3 bytes";
});

/* The next two matter even though they are supposed to fail: they prove the
   endpoint really verifies signatures. An endpoint that answers 200 to a
   forged URL would make every green check above meaningless. */

await check("a tampered signature is refused", async () => {
  if (!putWorked) throw new Error("nothing was stored, so there is nothing to read");

  const signed = await presign("GET", probeKey);
  const forged = signed.url.replace(/X-Amz-Signature=([0-9a-f]{63})([0-9a-f])/,
    (_match, head, last) => "X-Amz-Signature=" + head + (last === "0" ? "1" : "0"));

  if (forged === signed.url) throw new Error("could not build a tampered URL — the signature is not where it should be");

  const response = await fetch(forged);
  if (response.ok) {
    throw new Error("a URL with a broken signature was accepted. Media behind this endpoint is not " +
      "protected by the signature at all — stop and fix the bucket settings before uploading.");
  }
  expect(response.status, 403, "forged status");
  return "403";
});

await check("an expired signature is refused", async () => {
  if (!putWorked) throw new Error("nothing was stored, so there is nothing to read");

  const signed = await presign("GET", probeKey, {
    date: new Date(Date.now() - 2 * 24 * 3600 * 1000),
    expiresIn: 60
  });
  const response = await fetch(signed.url);
  if (response.ok) throw new Error("a two-day-old, one-minute link was still accepted");
  expect(response.status, 403, "expired status");
  return "403";
});

/* ------------------------------------------------------- the Worker's path */

console.log("\nPlayback path (B2 native API, what the CDN Worker fetches upstream)");

await check("the native download endpoint serves the object with the account token", async () => {
  if (!authorization) throw new Error("no authorization token");
  if (!downloadUrl) throw new Error("no downloadUrl in the authorize response");

  const { response, body } = await nativeCall(nativeUrl(probeKey), {
    Authorization: authorization.authorizationToken
  });
  expect(response.status, 200, "native status");
  if (sha256(body) !== probeHash) throw new Error("the native download returned different bytes");
  return "token accepted";
});

await check("the native download endpoint honours Range (seeking)", async () => {
  if (!authorization) throw new Error("no authorization token");

  const { response, body } = await nativeCall(nativeUrl(probeKey), {
    Authorization: authorization.authorizationToken,
    Range: "bytes=0-2"
  });
  expect(response.status, 206, "native range status");
  if (body.length !== 3) throw new Error("expected 3 bytes, got " + body.length);
  return "206, 3 bytes";
});

await check("the bucket is private (the same URL without a token is refused)", async () => {
  if (!authorization) throw new Error("no authorization token");

  const { response } = await nativeCall(nativeUrl(probeKey));
  if (response.ok) {
    throw new Error("the bucket served media to an anonymous request. Every clip would be public — " +
      "set the bucket to Private in the B2 console.");
  }
  if (response.status !== 401 && response.status !== 403) {
    throw new Error("expected 401/403 without a token, got " + response.status);
  }
  return String(response.status);
});

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleanup");

await check("the probe object is removed", async () => {
  if (!putWorked) throw new Error("nothing was stored, so there is nothing to remove");
  if (options.keep) {
    console.log("  (--keep) the probe stays at " + probeKey);
    return "left in place";
  }

  const signed = await presign("DELETE", probeKey);
  const response = await fetch(signed.url, { method: "DELETE" });
  if (response.ok || response.status === 404) return "deleted";

  if (response.status === 403) {
    throw new Error(`deleting needs the deleteFiles capability, which this key lacks. Remove ` +
      `${probeKey} from the bucket by hand.`);
  }
  throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
});

/* ------------------------------------------------------------------ verdict */

const passed = checks - failures;
console.log("\n" + (failures ? "\x1b[31mFAILED\x1b[0m" : "\x1b[32mPASSED\x1b[0m") +
  " — " + passed + "/" + checks + " checks" +
  (skipped.length ? " (" + skipped.length + " skipped)" : ""));

if (!failures) {
  console.log("\nThe bucket and keys are ready. Next, put them on the Worker:");
  console.log("  npx wrangler secret put B2_KEY_ID");
  console.log("  npx wrangler secret put B2_APPLICATION_KEY");
  console.log("  npx wrangler secret put MEDIA_SIGNING_KEY     # any long random string");
  console.log("  # and in wrangler.toml [vars]:  BUCKET_NAME = \"" + bucket + "\"");
  console.log("  npx wrangler deploy");
  console.log("\nThen upload a ladder:");
  console.log("  B2_KEY_ID=… B2_APPLICATION_KEY=… B2_BUCKET=" + bucket + " B2_REGION=" + (region || "…") +
    " \\\n    node tools/b2-upload.mjs ./my-hls --prefix hls/my-clip --cache-control 'public, max-age=31536000'");
}

process.exitCode = failures ? 1 : 0;
