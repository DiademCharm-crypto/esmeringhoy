/* ============================================================================
   ESMERINGHOY — BACKBLAZE B2 BUCKET SETUP
   ----------------------------------------------------------------------------
   One-time preparation so the admin panel can upload from a web browser.

   Two things have to be true before a browser may PUT a file to B2:
     1. The bucket must have the S3-compatible API enabled.
     2. The bucket must have CORS rules that allow a browser to issue that PUT.
        B2 denies every CORS preflight by default, and its *native* API cannot
        be called from a page at all — so this cannot be done from the admin
        panel itself. It runs here, once, with your key.

   Usage:
     B2_KEY_ID=... B2_APPLICATION_KEY=... B2_BUCKET=my-bucket B2_REGION=us-west-004 \
       node tools/b2-setup.mjs

   Options:
     --dry-run        Print the changes without applying them
     --origins LIST   Comma-separated origins allowed to upload (default: *)
     --allow-download Also allow browser downloads straight from B2

   Environment:
     B2_KEY_ID            Application key ID (an applicationKeyId, not accountId)
     B2_APPLICATION_KEY   Application key
     B2_BUCKET            Bucket name
     B2_BUCKET_ID         Optional: skips the bucket lookup (needs no listBuckets)
     B2_REGION            Optional: only used to print the S3 endpoint
     B2_API_URL           Optional: API root override, for testing against a
                          stand-in instead of the live Backblaze API

   Key capability note: updating bucket settings needs a key with the
   writeBuckets capability. A key scoped to "Read and Write" for one bucket is
   the right key for uploading, but it usually cannot change bucket settings —
   use your master application key for this one-time setup.
   ========================================================================== */

import { parseArgs } from "node:util";

const API_ROOT = (process.env.B2_API_URL || "https://api.backblazeb2.com/b2api/v2").replace(/\/+$/, "");

const { values: options } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    origins: { type: "string" },
    "allow-download": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false }
  },
  allowPositionals: false
});

if (options.help) {
  console.log("See the header of tools/b2-setup.mjs for usage.");
  process.exit(0);
}

const keyId = process.env.B2_KEY_ID;
const appKey = process.env.B2_APPLICATION_KEY;
const bucketName = process.env.B2_BUCKET;
let bucketId = process.env.B2_BUCKET_ID;
const region = process.env.B2_REGION;

/* Fatal errors are thrown, not process.exit()ed. On Windows, exiting while the
   HTTP socket is still closing trips a libuv assertion and reports a bogus exit
   code for a command that behaved correctly. Setting exitCode and letting the
   event loop drain gives the real status and no abort. */
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
if (!bucketName && !bucketId) {
  die("set B2_BUCKET (the bucket name) or B2_BUCKET_ID.");
}

const origins = options.origins
  ? options.origins.split(",").map((o) => o.trim()).filter(Boolean)
  : ["*"];

/* --------------------------------------------------------------- B2 calls -- */

async function callApi(path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = token;
  else headers.Authorization = "Basic " + Buffer.from(`${keyId}:${appKey}`).toString("base64");
  if (body) headers["Content-Type"] = "application/json";

  const response = await fetch(API_ROOT + path, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    /* Exit is normal for this script; a lingering keep-alive socket makes
       Node abort during shutdown on Windows. Ask for close instead. */
    keepalive: false
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const code = payload.code ? `${payload.code}: ` : "";
    throw new Error(`${path} -> HTTP ${response.status} ${code}${payload.message || text}`);
  }
  return payload;
}

console.log("authorizing with Backblaze…");
const auth = await callApi("/b2_authorize_account");
const token = auth.authorizationToken;
console.log("  account " + auth.accountId + ", api " + auth.apiUrl);

if (!bucketId) {
  console.log("looking up bucket " + JSON.stringify(bucketName) + "…");
  const listed = await callApi("/b2_list_buckets", { token, body: { accountId: auth.accountId, bucketName } });
  const match = (listed.buckets || []).find((b) => b.bucketName === bucketName);
  if (!match) {
    die(`bucket ${JSON.stringify(bucketName)} not found, or this key cannot list buckets ` +
      `(capability listBuckets). Pass B2_BUCKET_ID instead.`);
  }
  bucketId = match.bucketId;
  console.log("  bucketId " + bucketId);
}

/* Fetch current settings so the update is additive, not destructive. */
const current = await callApi("/b2_list_buckets", {
  token,
  body: { accountId: auth.accountId, bucketId }
}).catch(() => null);
const existing = current && (current.buckets || []).find((b) => b.bucketId === bucketId);
const existingOptions = existing ? (existing.options || []) : null;

/* ----------------------------------------------------------------- changes -- */

const corsRules = [
  {
    corsRuleName: "esmeringhoyBrowserUpload",
    allowedOrigins: origins,
    allowedHeaders: ["*"],
    /* s3_put is what a presigned PUT needs; b2_upload_file is here so the
       native upload path stays available too. */
    allowedOperations: ["s3_put", "b2_upload_file"],
    exposeHeaders: ["etag"],
    maxAgeSeconds: 3600
  }
];

if (options["allow-download"]) {
  corsRules.push({
    corsRuleName: "esmeringhoyBrowserDownload",
    allowedOrigins: origins,
    allowedHeaders: ["*"],
    allowedOperations: ["s3_get", "s3_head", "b2_download_file_by_name"],
    exposeHeaders: ["etag", "content-range"],
    maxAgeSeconds: 3600
  });
}

const update = { accountId: auth.accountId, bucketId, bucketName, corsRules };
const needsS3 = !existingOptions || !existingOptions.includes("s3");
if (needsS3) update.options = (existingOptions || ["b2"]).concat("s3");

console.log("\nplanned changes to " + (bucketName || bucketId) + ":");
console.log("  cors rules:");
corsRules.forEach((rule) => {
  console.log("    - " + rule.allowedOperations.join(", ") +
    " from " + rule.allowedOrigins.join(", "));
});
console.log("  s3-compatible api: " + (needsS3 ? "enable (was: " + (existingOptions || ["unknown"]).join(",") + ")" : "already enabled"));

/* Deliberately not process.exit() here: exiting while the client socket is
   still closing trips a libuv assertion on Windows and reports a bogus exit
   code for a run that succeeded. Let Node drain and exit on its own. */
if (options["dry-run"]) {
  console.log("\ndry run — nothing was changed.");
  if (region) console.log("s3 endpoint would be https://s3." + region + ".backblazeb2.com");
} else {
  console.log("\napplying…");
  const updated = await callApi("/b2_update_bucket", { token, body: update });

  console.log("\x1b[32mdone\x1b[0m — bucket revision " + updated.revision);
  (updated.corsRules || []).forEach((rule) => {
    console.log("  " + rule.corsRuleName + ": " + rule.allowedOperations.join(", ") +
      " from " + rule.allowedOrigins.join(", "));
  });

  console.log("\nnext:");
  if (region) {
    console.log("  S3 endpoint : https://s3." + region + ".backblazeb2.com");
    console.log("  Region      : " + region);
  } else {
    console.log("  Copy the S3 endpoint shown in the B2 console (Bucket Details) and its");
    console.log("  region segment, e.g. https://s3.us-west-004.backblazeb2.com -> us-west-004");
  }
  console.log("  Admin panel : paste the key ID, key, bucket and region into “Upload to B2”.");
}
