/* ============================================================================
   ESMERINGHOY — UPLOAD FILES OR A WHOLE FOLDER TO BACKBLAZE B2
   ----------------------------------------------------------------------------
   The companion to tools/hls-encode.sh: an HLS ladder is dozens of files, so
   uploading it by hand from the admin panel is not practical. This pushes a
   folder (or one file) with S3 presigned PUTs — the same mechanism the admin
   panel uses — and sets the Content-Type B2 needs for each file, which is the
   single most common reason a freshly uploaded video will not play.

   Usage:
     B2_KEY_ID=... B2_APPLICATION_KEY=... B2_BUCKET=my-bucket B2_REGION=us-west-004 \
       node tools/b2-upload.mjs ./portrait-hls --prefix hls/portrait

   Options:
     --prefix PATH      Key prefix inside the bucket (default: the folder name)
     --region REGION    B2 region, e.g. us-west-004 (or set B2_REGION)
     --endpoint URL     Override the S3 endpoint entirely
     --concurrency N    Parallel uploads (default 4)
     --cache-control V  Cache-Control stored with every object
     --skip-existing    HEAD each key first and skip what is already there
     --dry-run          List what would be uploaded, sign nothing
   ========================================================================== */

import { createRequire } from "node:module";
import { readdir, stat, readFile, open } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const SigV4 = require("../signv4.js");

/* ------------------------------------------------------------------- setup -- */

const { values: options, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    prefix: { type: "string" },
    region: { type: "string" },
    endpoint: { type: "string" },
    concurrency: { type: "string", default: "4" },
    "cache-control": { type: "string" },
    "skip-existing": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false }
  },
  allowPositionals: true
});

if (options.help || positionals.length === 0) {
  console.log("See the header of tools/b2-upload.mjs for usage.");
  process.exit(positionals.length === 0 && !options.help ? 1 : 0);
}

const keyId = process.env.B2_KEY_ID;
const appKey = process.env.B2_APPLICATION_KEY;
const bucket = process.env.B2_BUCKET;
const region = options.region || process.env.B2_REGION;
const endpoint = options.endpoint || (region ? `https://s3.${region}.backblazeb2.com` : null);

function die(message) {
  console.error("\x1b[31merror:\x1b[0m " + message);
  process.exit(1);
}

if (!options["dry-run"]) {
  if (!keyId || !appKey) die("set B2_KEY_ID and B2_APPLICATION_KEY.");
  if (!bucket) die("set B2_BUCKET.");
  if (!endpoint) die("set B2_REGION (e.g. us-west-004) or --endpoint.");
  if (!/^[a-z]{2}-[a-z]+-\d{3}$/.test(region || "")) {
    die(`B2_REGION looks wrong: ${JSON.stringify(region)}. It is the cluster name from your ` +
      `bucket's S3 endpoint, e.g. us-west-004 or eu-central-003.`);
  }
}
if (!region && endpoint) {
  /* Derive the signing region from the endpoint when only --endpoint was given. */
  const match = /s3\.([a-z]{2}-[a-z]+-\d{3})\.backblazeb2\.com/.exec(endpoint);
  if (!match) die("could not read the region out of --endpoint; pass --region too.");
}

const signingRegion = region ||
  /s3\.([a-z]{2}-[a-z]+-\d{3})\.backblazeb2\.com/.exec(endpoint)[1];

/* ------------------------------------------------------------ content types */

const TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4s": "video/iso.segment",
  ".ts": "video/mp2t",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".vtt": "text/vtt",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

function contentTypeFor(file) {
  return TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

/* ------------------------------------------------------------- collect work */

const inputPath = path.resolve(positionals[0]);

let info;
try {
  info = await stat(inputPath);
} catch {
  die("no such file or folder: " + inputPath);
}

const prefix = (options.prefix ?? (info.isDirectory() ? path.basename(inputPath) : ""))
  .replace(/^\/+|\/+$/g, "");

async function collect(target, keys) {
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) await collect(full, keys);
    else if (entry.isFile()) keys.push(full);
  }
  return keys;
}

const files = info.isDirectory() ? await collect(inputPath, []) : [inputPath];
if (!files.length) die("nothing to upload in " + inputPath);

const jobs = [];
for (const file of files) {
  const relative = info.isDirectory()
    ? path.relative(inputPath, file).split(path.sep).join("/")
    : path.basename(file);
  const key = prefix ? `${prefix}/${relative}` : relative;
  const fileStat = await stat(file);
  jobs.push({ file, key, size: fileStat.size, type: contentTypeFor(file) });
}

const totalBytes = jobs.reduce((sum, job) => sum + job.size, 0);
const pretty = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + " MB";

console.log(`${jobs.length} file(s), ${pretty(totalBytes)} -> b2://${bucket || "<bucket>"}/${prefix || ""}`);
console.log(`endpoint ${endpoint} (region ${signingRegion})`);

if (options["dry-run"]) {
  jobs.forEach((job) => console.log("  PUT " + job.key + "  (" + job.type + ", " + pretty(job.size) + ")"));
  process.exit(0);
}

/* ------------------------------------------------------------------ upload -- */

const BODY_LIMIT = 512 * 1024 * 1024; /* Above this, stream instead of buffering. */

async function presign(method, key) {
  return SigV4.presignUrl({
    method,
    endpoint,
    bucket,
    key,
    region: signingRegion,
    accessKeyId: keyId,
    secretAccessKey: appKey,
    expiresIn: 3600
  });
}

async function bodyFor(file, size) {
  if (size <= BODY_LIMIT) return readFile(file);
  const handle = await open(file, "r");
  return handle.createReadStream({ autoClose: true });
}

async function putOnce(job) {
  const signed = await presign("PUT", job.key);
  const headers = { "Content-Type": job.type };
  if (options["cache-control"]) headers["Cache-Control"] = options["cache-control"];

  const body = await bodyFor(job.file, job.size);
  const response = await fetch(signed.url, {
    method: "PUT",
    headers,
    body,
    duplex: "half"
  });

  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw new Error(`HTTP ${response.status} ${text}`);
  }
  return response;
}

async function upload(job) {
  if (options["skip-existing"]) {
    const head = await presign("HEAD", job.key);
    const existing = await fetch(head.url, { method: "HEAD" }).catch(() => null);
    if (existing && existing.ok) {
      return { job, skipped: true, attempts: 0 };
    }
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await putOnce(job);
      return { job, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
    }
  }
  return { job, error: lastError };
}

const concurrency = Math.max(1, Math.min(16, Number(options.concurrency) || 4));
let next = 0;
let uploaded = 0;
let skipped = 0;
let sentBytes = 0;
const failures = [];

async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const index = `[${String(next).padStart(String(jobs.length).length)}/${jobs.length}]`;
    const result = await upload(job);
    if (result.error) {
      failures.push(result);
      console.error(`\x1b[31m  ${index} failed ${job.key}: ${result.error.message}\x1b[0m`);
    } else if (result.skipped) {
      skipped++;
      console.log(`  ${index} skipped ${job.key}`);
    } else {
      uploaded++;
      sentBytes += job.size;
      console.log(`  ${index} ok      ${job.key}  (${job.type}, ${pretty(job.size)})`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

console.log(`\nuploaded ${uploaded}, skipped ${skipped}, failed ${failures.length} — ${pretty(sentBytes)} sent`);
if (failures.length) {
  console.error("\x1b[31msome files failed; re-run to retry just those (--skip-existing)\x1b[0m");
  process.exit(1);
}

const master = jobs.find((job) => job.key.endsWith("master.m3u8"));
if (master) {
  console.log("\npoint the clip's Video URL at: " + master.key);
  console.log("(the player switches quality automatically for any .m3u8 URL)");
}
