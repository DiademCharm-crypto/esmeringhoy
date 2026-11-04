/* ============================================================================
   ESMERINGHOY — LOCAL BACKBLAZE B2 STAND-IN  (test harness, never deployed)
   ----------------------------------------------------------------------------
   Exists so the pipeline can be tested without a Backblaze account: the upload
   flow, tools/b2-upload.mjs and worker/b2-cdn-worker.js all talk to this instead
   of the real thing, with the real fetch stack.

   It speaks the parts of B2 that the project uses:
     S3 path-style    PUT / HEAD / GET / DELETE  /<bucket>/<key>  (presigned only)
     B2 native        GET                /file/<bucket>/<key>  (needs the token)
     B2 API           POST /b2api/v2/b2_authorize_account | b2_list_buckets |
                           b2_update_bucket                (tools/b2-setup.mjs)
     test only        GET  /_dump    -> what is stored
                      GET  /_requests -> the last 40 requests

   Usage:
     node tools/b2-stand-in.mjs [port] [seedDir]

   Credentials are fixed: key id `test-key-id`, key `test-app-key`. The bucket
   is private, and it enforces that on both of its APIs — a stand-in that
   accepts anything is worse than no stand-in, because a broken signature would
   then only be discovered against the real service:

     native  /file/<bucket>/<key>  needs the authorize token, else 401
     S3      /<bucket>/<key>       needs a valid presigned URL, else 403
                                   (unsigned, tampered and expired all fail)

   The signature check is a second implementation written against the AWS
   grammar (node:crypto here, never signv4.js), so it can actually disagree
   with the signer it is checking. tools/b2-check.mjs probes the same way
   against whatever endpoint you point it at.
   ========================================================================== */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const ROOT = process.env.B2_STORE_DIR || path.join(os.tmpdir(), "b2-store");
const PORT = Number(process.argv[2] || 8090);
const BUCKET_NAME = "esmeringhoy-media";
const TEST_KEY_ID = "test-key-id";
const TEST_APP_KEY = "test-app-key";
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

/* ------------------------------------------------------ signature checking --
   A presigned URL is checked exactly the way Backblaze checks it: the
   canonical request is rebuilt from what actually arrived (method, raw path,
   query without the signature, the signed headers) and the signature is
   recomputed with an independent HMAC/SHA-256 implementation. Reusing
   signv4.js here would compare the signer with itself and agree with every
   mistake, which is the opposite of the point. */

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const MAX_EXPIRES = 604800;      /* B2/S3 ceiling: seven days */
const MAX_CLOCK_SKEW = 900;      /* B2 tolerates 15 minutes of clock drift */

function hmac(key, message) {
  return crypto.createHmac("sha256", key).update(message).digest();
}

function signingKey(secret, dateStamp, region, service) {
  return hmac(hmac(hmac(hmac("AWS4" + secret, dateStamp), region), service), "aws4_request");
}

function parseAmzDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(value || ""));
  if (!match) return null;
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
}

/* {ok:true} for a request this bucket would accept, otherwise {ok:false, code,
   message} in the shape B2 reports it. */
function verifyPresignedObject(req, url) {
  const query = url.searchParams;

  if (query.get("X-Amz-Algorithm") !== ALGORITHM) {
    return { ok: false, code: "AccessDenied", message: "a private bucket needs a presigned URL" };
  }

  const credential = String(query.get("X-Amz-Credential") || "").split("/");
  if (credential.length !== 5 || credential[0] !== TEST_KEY_ID || credential[4] !== "aws4_request") {
    return { ok: false, code: "InvalidAccessKeyId", message: "unknown key " + JSON.stringify(credential[0] || "") };
  }
  const [, dateStamp, region, service] = credential;

  const amzDate = String(query.get("X-Amz-Date") || "");
  const issued = parseAmzDate(amzDate);
  if (issued === null) {
    return { ok: false, code: "AuthorizationQueryParametersError", message: "X-Amz-Date is not an ISO8601 basic timestamp" };
  }

  const expires = Number(query.get("X-Amz-Expires"));
  if (!Number.isFinite(expires) || expires <= 0 || expires > MAX_EXPIRES) {
    return { ok: false, code: "AuthorizationQueryParametersError", message: "X-Amz-Expires must be 1.." + MAX_EXPIRES };
  }

  const age = (Date.now() - issued) / 1000;
  if (age > expires) {
    return { ok: false, code: "AccessDenied", message: "Request has expired: signed " + Math.round(age) + "s ago, valid for " + expires + "s" };
  }
  if (age < -MAX_CLOCK_SKEW) {
    return { ok: false, code: "RequestTimeTooSkewed", message: "X-Amz-Date is " + Math.round(-age) + "s in the future" };
  }

  const signedHeaders = String(query.get("X-Amz-SignedHeaders") || "").split(";").filter(Boolean);
  if (!signedHeaders.includes("host")) {
    return { ok: false, code: "AuthorizationHeaderMalformed", message: "host has to be one of the signed headers" };
  }

  const signature = String(query.get("X-Amz-Signature") || "");
  if (!/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, code: "SignatureDoesNotMatch", message: "X-Amz-Signature is missing or malformed" };
  }

  const rawTarget = String(req.url);
  const canonicalUri = rawTarget.split("?")[0];
  const canonicalQuery = (rawTarget.split("?")[1] || "")
    .split("&")
    .filter((pair) => !/^X-Amz-Signature=/i.test(pair))
    .join("&");

  const canonicalHeaders = signedHeaders
    .map((name) => {
      const value = req.headers[name.toLowerCase()];
      return name + ":" + String(value == null ? "" : value).trim() + "\n";
    })
    .join("");

  const payloadHash = signedHeaders.includes("x-amz-content-sha256")
    ? String(req.headers["x-amz-content-sha256"])
    : UNSIGNED_PAYLOAD;

  const scope = [dateStamp, region, service, "aws4_request"].join("/");
  const canonicalRequest = [
    req.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");

  const expected = hmac(signingKey(TEST_APP_KEY, dateStamp, region, service), stringToSign);
  const received = Buffer.from(signature, "hex");
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return { ok: false, code: "SignatureDoesNotMatch", message: "the signature does not match this request" };
  }

  return { ok: true, region, service };
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
      bucketName: BUCKET_NAME,
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
      bucketName: BUCKET_NAME,
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
      allowed: { bucketName: BUCKET_NAME, capabilities: ["readFiles", "writeFiles"] }
    }));
    return;
  }

  /* --- S3-style object paths ------------------------------------------------
     Verified before anything is stored or served, the way a private bucket
     behaves. This path used to accept a bare PUT, so a wrong signature in the
     upload flow could only ever be found against the real service, at the end
     of a large upload — the browser could not have caught it either. */
  const isNativePath = parts[0] === "file";
  if (
    req.method === "PUT" ||
    req.method === "DELETE" ||
    (!isNativePath && (req.method === "HEAD" || req.method === "GET"))
  ) {
    const verdict = verifyPresignedObject(req, url);
    if (!verdict.ok) {
      log({ rejected: verdict.code, method: req.method, path: url.pathname });
      res.writeHead(403, { "Content-Type": "application/json" })
        .end(JSON.stringify({ code: verdict.code, message: verdict.message }));
      return;
    }
    if (bucket !== BUCKET_NAME) {
      res.writeHead(404, { "Content-Type": "application/json" })
        .end(JSON.stringify({ code: "NoSuchBucket", message: "no such bucket: " + bucket }));
      return;
    }

    const file = storePath(bucket, key);

    if (req.method === "PUT") {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await fsp.writeFile(file, Buffer.concat(chunks));
      log({ stored: bucket + "/" + key, bytes: Buffer.concat(chunks).length, contentType: req.headers["content-type"], signature: "valid" });
      res.writeHead(200, { ETag: '"sim-etag"' }).end("");
      return;
    }

    if (req.method === "DELETE") {
      await fsp.rm(file, { force: true });
      log({ deleted: bucket + "/" + key, signature: "valid" });
      res.writeHead(204).end();
      return;
    }

    await serveFile(req, res, file);
    return;
  }

  if (req.method === "HEAD" || req.method === "GET") {
    /* The native API is authorized with the account token from
       b2_authorize_account, which is what makes the Worker's fetch path
       meaningful: without it a private bucket answers 401. */
    if (req.headers.authorization !== "sim-account-token") {
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
