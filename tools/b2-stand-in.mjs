/* ============================================================================
   ESMERINGHOY — LOCAL BACKBLAZE B2 STAND-IN  (test harness, never deployed)
   ----------------------------------------------------------------------------
   Exists so the pipeline can be tested without a Backblaze account: the upload
   flow, tools/b2-upload.mjs and worker/b2-cdn-worker.js all talk to this instead
   of the real thing, with the real fetch stack.

   It speaks the parts of B2 that the project uses:
     S3 path-style    PUT / HEAD / GET   /<bucket>/<key>   (presigned uploads)
     B2 native        GET                /file/<bucket>/<key>  (needs the token)
     B2 API           POST /b2api/v2/b2_authorize_account | b2_list_buckets |
                           b2_update_bucket                (tools/b2-setup.mjs)
     test only        GET  /_dump    -> what is stored
                      GET  /_requests -> the last 40 requests

   Usage:
     node tools/b2-stand-in.mjs [port] [seedDir]

   Credentials are fixed: key id `test-key-id`, key `test-app-key`.
   The bucket is private, and answers 401 without the auth token — which is
   what makes the Worker's authorization path meaningful.
   ========================================================================== */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const ROOT = process.env.B2_STORE_DIR || path.join(os.tmpdir(), "b2-store");
const PORT = Number(process.argv[2] || 8090);
const SEED = process.argv[3] || null; /* optional dir copied into the store */

/* Mutable bucket settings so b2-setup.mjs can be exercised for real. */
let bucketRevision = 7;
let bucketOptions = ["b2"]; /* deliberately missing "s3", as a fresh bucket can be */
let bucketCors = [];

const TYPES = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".ts": "video/mp2t"
};

const requests = [];

function log(entry) {
  requests.push(entry);
  if (process.env.SIM_LOG) console.log(JSON.stringify(entry));
}

function contentType(p) {
  return TYPES[path.extname(p).toLowerCase()] || "application/octet-stream";
}

/* A bucket CORS rule, as the real B2 would have after tools/b2-setup.mjs. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "ETag, Content-Range, Content-Length, Accept-Ranges"
};

function withCors(res) {
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (status, headers) => {
    const merged = Object.assign({}, CORS, headers || {});
    if (typeof headers === "string") return originalWriteHead(status, headers);
    return originalWriteHead(status, merged);
  };
  return res;
}

function storePath(bucket, key) {
  const safe = path.normalize(key).replace(/^(\.\.[\\/])+/, "");
  return path.join(ROOT, bucket, safe);
}

async function copyDir(from, to) {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else await fsp.copyFile(src, dst);
  }
}

async function serveFile(req, res, file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    return;
  }

  /* A key that resolves to a directory is not an object. Serving it used to
     crash the process via an EISDIR read stream. */
  if (!stat.isFile()) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ code: "notFound", message: "not an object" }));
    return;
  }

  function pipeStream(stream, res) {
    stream.on("error", function (err) {
      console.error("stream error:", err.message);
      if (!res.headersSent) res.writeHead(500).end("read error");
      else res.destroy();
    });
    stream.pipe(res);
  }

  const headers = {
    "Content-Type": contentType(file),
    "Accept-Ranges": "bytes",
    "ETag": '"' + stat.size + "-" + stat.mtimeMs + '"'
  };

  headers["Cache-Control"] = "public, max-age=60";

  /* Range support mirrors B2, which matters for seeking. */
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
      headers["Content-Length"] = String(end - start + 1);
      res.writeHead(206, headers);
      if (req.method === "HEAD") return res.end();
      pipeStream(fs.createReadStream(file, { start, end }), res);
      return;
    }
  }

  headers["Content-Length"] = String(stat.size);
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  pipeStream(fs.createReadStream(file), res);
}

process.on("uncaughtException", function (err) {
  console.error("uncaught:", err && err.message);
});

const server = http.createServer(async (req, res) => {
  withCors(res);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.replace(/^\/+/, "").split("/");
  const bucket = parts[0] === "file" ? parts[1] : parts[0];
  const key = parts.slice(parts[0] === "file" ? 2 : 1).join("/");

  log({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || null });

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === "/_dump") {
    const out = [];
    async function walk(dir, prefix) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, prefix + entry.name + "/");
        else {
          const s = await fsp.stat(full);
          out.push({ key: prefix + entry.name, size: s.size, type: contentType(full) });
        }
      }
    }
    await walk(ROOT, "");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out, null, 2));
    return;
  }

  if (url.pathname === "/_requests") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(requests.slice(-40), null, 2));
    return;
  }

  /* --- bucket metadata endpoints used by tools/b2-setup.mjs --- */
  const authOk = req.headers.authorization === "sim-account-token";

  async function readJson() {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
  }

  if (url.pathname === "/b2api/v2/b2_list_buckets") {
    if (!authOk) {
      res.writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ code: "unauthorized", message: "bad token" }));
      return;
    }
    const body = await readJson();
    const bucket = {
      accountId: "sim-account",
      bucketId: "sim-bucket-id",
      bucketName: "esmeringhoy-media",
      bucketType: "allPrivate",
      revision: bucketRevision,
      options: bucketOptions,
      corsRules: bucketCors
    };
    const matches = (body.bucketName && body.bucketName !== bucket.bucketName) ||
      (body.bucketId && body.bucketId !== bucket.bucketId) ? [] : [bucket];
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ buckets: matches }));
    return;
  }

  if (url.pathname === "/b2api/v2/b2_update_bucket") {
    if (!authOk) {
      res.writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ code: "unauthorized", message: "bad token" }));
      return;
    }
    const body = await readJson();
    if (body.bucketId !== "sim-bucket-id") {
      res.writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ code: "bad_bucket_id", message: "no such bucket" }));
      return;
    }
    if (Array.isArray(body.corsRules)) bucketCors = body.corsRules;
    if (Array.isArray(body.options)) bucketOptions = body.options;
    bucketRevision++;
    log({ appliedUpdate: { corsRules: body.corsRules, options: body.options } });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      accountId: "sim-account",
      bucketId: "sim-bucket-id",
      bucketName: "esmeringhoy-media",
      bucketType: "allPrivate",
      revision: bucketRevision,
      options: bucketOptions,
      corsRules: bucketCors
    }));
    return;
  }

  if (url.pathname === "/b2api/v2/b2_authorize_account") {
    const basic = Buffer.from("test-key-id:test-app-key").toString("base64");
    if (req.headers.authorization !== "Basic " + basic) {
      res.writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ status: 401, code: "unauthorized", message: "bad credentials" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      accountId: "sim-account",
      authorizationToken: "sim-account-token",
      apiUrl: `http://127.0.0.1:${PORT}`,
      downloadUrl: `http://127.0.0.1:${PORT}`,
      allowed: { bucketName: "esmeringhoy-media", capabilities: ["readFiles", "writeFiles"] }
    }));
    return;
  }

  if (req.method === "PUT") {
    const file = storePath(bucket, key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await fsp.writeFile(file, Buffer.concat(chunks));
    log({ stored: bucket + "/" + key, bytes: Buffer.concat(chunks).length, contentType: req.headers["content-type"] });
    res.writeHead(200, { ETag: '"sim-etag"' }).end("");
    return;
  }

  if (req.method === "HEAD" || req.method === "GET") {
    /* A private bucket requires the native API's token, so require it here too —
       that is what makes the Worker's authorization path meaningful. */
    if (parts[0] === "file" && req.headers.authorization !== "sim-account-token") {
      res.writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ code: "unauthorized", message: "missing auth token" }));
      return;
    }
    await serveFile(req, res, storePath(bucket, key));
    return;
  }

  res.writeHead(405).end("method not allowed");
});

(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(ROOT, { recursive: true });
  if (SEED) await copyDir(SEED, path.join(ROOT, "esmeringhoy-media/hls/seeded"));
  console.log("store: " + ROOT);
  server.listen(PORT, "127.0.0.1", () => console.log("b2 sim on http://127.0.0.1:" + PORT));
})();
