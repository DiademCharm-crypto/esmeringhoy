/* ============================================================================
   ESMERINGHOY — SigV4 SIGNING TEST SUITE
   ----------------------------------------------------------------------------
   Run:  node tools/sigv4.test.mjs

   The upload flow lives or dies on the signature being *exactly* right, and a
   wrong signature fails only at the very end of a multi-gigabyte upload. So it
   is checked here against published values instead of against itself:

     1. AWS's own SigV4 test vectors from the S3 developer guide
        ("Examples: Signature Calculations"), which publish the canonical
        request, the string to sign and the resulting signature.
     2. aws4fetch (the reference implementation Backblaze's own Cloudflare
        Worker sample uses), compared presign-for-presign. Optional: it is not a
        project dependency, so point AWS4FETCH_PATH at a copy to enable it.

   Exit status is non-zero if any check fails.
   ========================================================================== */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const SigV4 = require("../signv4.js");

let failures = 0;
let checks = 0;

function check(name, fn) {
  checks++;
  try {
    const result = fn();
    /* An async body here would throw after this function returned, turning a
       real failure into a silent pass. Refuse it instead. */
    if (result && typeof result.then === "function") {
      throw new Error("async check passed to check(); use checkAsync()");
    }
    console.log("  ok   " + name);
  } catch (err) {
    failures++;
    console.log("  FAIL " + name + "\n       " + err.message.split("\n").join("\n       "));
  }
}

async function checkAsync(name, fn) {
  checks++;
  try {
    await fn();
    console.log("  ok   " + name);
  } catch (err) {
    failures++;
    console.log("  FAIL " + name + "\n       " + err.message.split("\n").join("\n       "));
  }
}

/* --------------------------------------------------------------------------
   AWS published vectors
   -------------------------------------------------------------------------- */

const AWS_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const AWS_WHEN = new Date("2013-05-24T00:00:00Z");

console.log("\nAWS SigV4 published test vectors");

await checkAsync("GET Object vector produces the documented signature", async () => {
  const signed = await SigV4.signRequest({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { range: "bytes=0-9" },
    region: "us-east-1",
    service: "s3",
    accessKeyId: AWS_ACCESS_KEY,
    secretAccessKey: AWS_SECRET_KEY,
    date: AWS_WHEN
  });

  /* Line 3 is the (empty) query string; the blank line after the header block
     is the delimiter AWS's grammar requires. The docs render both empty lines
     as nothing, so the structure is spelled out here. */
  assert.equal(
    signed.canonicalRequest,
    [
      "GET",
      "/test.txt",
      "",
      "host:examplebucket.s3.amazonaws.com",
      "range:bytes=0-9",
      "x-amz-content-sha256:" + SigV4.EMPTY_SHA256,
      "x-amz-date:20130524T000000Z",
      "",
      "host;range;x-amz-content-sha256;x-amz-date",
      SigV4.EMPTY_SHA256
    ].join("\n"),
    "canonical request differs from the published example"
  );

  assert.match(
    signed.stringToSign,
    /7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972$/,
    "string-to-sign hash differs from the published example"
  );

  assert.equal(
    signed.signature,
    "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    "signature differs from the published example"
  );
});

await checkAsync("PUT Object vector handles the $ key and Date header", async () => {
  const signed = await SigV4.signRequest({
    method: "PUT",
    url: "https://examplebucket.s3.amazonaws.com/test$file.text",
    headers: {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      "x-amz-storage-class": "REDUCED_REDUNDANCY"
    },
    region: "us-east-1",
    service: "s3",
    accessKeyId: AWS_ACCESS_KEY,
    secretAccessKey: AWS_SECRET_KEY,
    payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    date: AWS_WHEN
  });

  assert.equal(
    signed.canonicalRequest,
    [
      "PUT",
      "/test%24file.text",
      "",
      "date:Fri, 24 May 2013 00:00:00 GMT",
      "host:examplebucket.s3.amazonaws.com",
      "x-amz-content-sha256:44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      "x-amz-date:20130524T000000Z",
      "x-amz-storage-class:REDUCED_REDUNDANCY",
      "",
      "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class",
      "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
    ].join("\n"),
    "canonical request differs from the published example"
  );

  assert.equal(
    await SigV4.sha256Hex(signed.canonicalRequest),
    "9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d",
    "canonical request hash differs from the published example"
  );
});

/* --------------------------------------------------------------------------
   URI encoding (the usual source of mystery signature mismatches)
   -------------------------------------------------------------------------- */

console.log("\nUriEncode");

check("leaves unreserved characters alone", () => {
  assert.equal(SigV4.uriEncode("aZ09-_.~", true), "aZ09-_.~");
});

check("keeps slashes in keys unless asked to encode them", () => {
  assert.equal(SigV4.uriEncode("photos/Jan/sample.jpg", false), "photos/Jan/sample.jpg");
  assert.equal(SigV4.uriEncode("photos/Jan/sample.jpg", true), "photos%2FJan%2Fsample.jpg");
});

check("encodes the characters encodeURIComponent() misses", () => {
  assert.equal(SigV4.uriEncode("a b", true), "a%20b");
  assert.equal(SigV4.uriEncode("a+b", true), "a%2Bb");
  assert.equal(SigV4.uriEncode("*", true), "%2A");
  assert.equal(SigV4.uriEncode("!", true), "%21");
  assert.equal(SigV4.uriEncode("'", true), "%27");
  assert.equal(SigV4.uriEncode("(", true), "%28");
  assert.equal(SigV4.uriEncode(")", true), "%29");
});

check("uses uppercase hex and multi-byte UTF-8", () => {
  assert.equal(SigV4.uriEncode("é", true), "%C3%A9");
  assert.equal(SigV4.uriEncode("🎬", true), "%F0%9F%8E%AC");
});

/* --------------------------------------------------------------------------
   Presigned URLs — the shape the admin panel actually sends
   -------------------------------------------------------------------------- */

console.log("\nPresigned URL shape");

const B2_ENDPOINT = "https://s3.us-west-004.backblazeb2.com";
const B2_BUCKET = "esmeringhoy-media";
const UPLOAD_KEY = "clips/Scene 01 — final.mp4";

const presigned = await SigV4.presignUrl({
  method: "PUT",
  endpoint: B2_ENDPOINT,
  bucket: B2_BUCKET,
  key: UPLOAD_KEY,
  region: "us-west-004",
  service: "s3",
  accessKeyId: AWS_ACCESS_KEY,
  secretAccessKey: AWS_SECRET_KEY,
  expiresIn: 3600,
  date: AWS_WHEN
});

check("carries the credential in the query string, not a header", () => {
  const url = new URL(presigned.url);
  assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "3600");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.equal(
    url.searchParams.get("X-Amz-Credential"),
    "AKIAIOSFODNN7EXAMPLE/20130524/us-west-004/s3/aws4_request"
  );
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
});

check("encodes the object key but keeps its slashes", () => {
  const url = new URL(presigned.url);
  assert.equal(url.pathname, "/esmeringhoy-media/clips/Scene%2001%20%E2%80%94%20final.mp4");
});

check("sorts the signed query parameters and appends the signature last", () => {
  const query = presigned.url.split("?")[1];
  const keys = query.split("&").map((p) => p.split("=")[0]);

  /* X-Amz-Signature is not part of what gets signed, so it sits outside the
     canonical ordering — at the end, as every AWS SDK emits it. */
  assert.equal(keys[keys.length - 1], "X-Amz-Signature");
  const signedKeys = keys.slice(0, -1);
  assert.deepEqual(signedKeys, signedKeys.slice().sort(), "signed parameters are not in canonical order");
});

await checkAsync("refuses to presign a URL that expires beyond the 7 day maximum", async () => {
  const capped = await SigV4.presignUrl({
    method: "PUT",
    endpoint: B2_ENDPOINT,
    bucket: B2_BUCKET,
    key: "clips/a.mp4",
    region: "us-west-004",
    accessKeyId: AWS_ACCESS_KEY,
    secretAccessKey: AWS_SECRET_KEY,
    expiresIn: 60 * 60 * 24 * 30,
    date: AWS_WHEN
  });
  assert.equal(new URL(capped.url).searchParams.get("X-Amz-Expires"), "604800");
});

await checkAsync("is stable for the same inputs and changes when the key changes", async () => {
  const base = {
    method: "PUT",
    endpoint: B2_ENDPOINT,
    bucket: B2_BUCKET,
    region: "us-west-004",
    accessKeyId: AWS_ACCESS_KEY,
    secretAccessKey: AWS_SECRET_KEY,
    expiresIn: 3600,
    date: AWS_WHEN
  };
  const a = await SigV4.presignUrl(Object.assign({ key: "clips/a.mp4" }, base));
  const b = await SigV4.presignUrl(Object.assign({ key: "clips/a.mp4" }, base));
  const c = await SigV4.presignUrl(Object.assign({ key: "clips/b.mp4" }, base));
  assert.equal(a.signature, b.signature, "same input gave a different signature");
  assert.notEqual(a.signature, c.signature, "a different key gave the same signature");
});

/* --------------------------------------------------------------------------
   Independent cross-check
   -------------------------------------------------------------------------- */

console.log("\nCross-check against aws4fetch (independent implementation)");

let AwsClient = null;
const aws4fetchRef = process.env.AWS4FETCH_PATH;
/* Accept a bare module name or a path (POSIX or Windows) to a copy. */
const aws4fetchSpec = aws4fetchRef && /[\\/]/.test(aws4fetchRef)
  ? pathToFileURL(aws4fetchRef).href
  : (aws4fetchRef || "aws4fetch");
try {
  const mod = await import(aws4fetchSpec);
  AwsClient = mod.AwsClient || (mod.default && mod.default.AwsClient);
} catch (err) {
  AwsClient = null;
  /* A bad AWS4FETCH_PATH is a setup mistake worth surfacing, not a silent skip. */
  if (aws4fetchRef) console.log("  note: " + err.message);
}

if (!AwsClient) {
  console.log("  SKIP aws4fetch not installed (set AWS4FETCH_PATH to a copy to enable)");
} else {
  const cases = [
    { name: "PUT upload", method: "PUT", key: "clips/Scene 01 — final.mp4", expiresIn: 86400 },
    { name: "GET playback", method: "GET", key: "clips/simple.mp4", expiresIn: 86400 },
    { name: "keys with subfolders and spaces", method: "GET", key: "hls/movie 1/master.m3u8", expiresIn: 86400 }
  ];

  for (const testCase of cases) {
    await checkAsync("matches aws4fetch: " + testCase.name, async () => {
      const url = SigV4.objectUrl(B2_ENDPOINT, B2_BUCKET, testCase.key);

      const reference = new AwsClient({
        accessKeyId: AWS_ACCESS_KEY,
        secretAccessKey: AWS_SECRET_KEY,
        service: "s3",
        region: "us-west-004"
      });
      const signed = await reference.sign(url, {
        method: testCase.method,
        datetime: SigV4.amzDate(AWS_WHEN),
        aws: { signQuery: true, allHeaders: false }
      });

      const mine = await SigV4.presignUrl({
        method: testCase.method,
        endpoint: B2_ENDPOINT,
        bucket: B2_BUCKET,
        key: testCase.key,
        region: "us-west-004",
        accessKeyId: AWS_ACCESS_KEY,
        secretAccessKey: AWS_SECRET_KEY,
        expiresIn: testCase.expiresIn,
        date: AWS_WHEN
      });

      assert.equal(
        new URL(mine.url).searchParams.get("X-Amz-Signature"),
        new URL(signed.url.toString()).searchParams.get("X-Amz-Signature"),
        "signature differs from aws4fetch"
      );
    });
  }
}

console.log("\n" + (failures ? "FAILED" : "PASSED") + " — " + (checks - failures) + "/" + checks + " checks\n");
process.exit(failures ? 1 : 0);
