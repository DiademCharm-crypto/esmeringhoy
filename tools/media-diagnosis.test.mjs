/* ============================================================================
   ESMERINGHOY — MEDIA DIAGNOSIS TEST SUITE
   ----------------------------------------------------------------------------
   Run:  node tools/media-diagnosis.test.mjs

   media-diagnosis.js is a lookup table, and a lookup table is exactly the kind
   of code that fails quietly: a mistyped key or a lost branch still returns a
   message, just the wrong one — and the wrong one sends you to the wrong
   system. So every code the Worker can emit is checked here, including the two
   that are awkward to reproduce by hand (a Worker with no signing key, a
   bucket it cannot reach), and the checks are about the *content* of the
   answer: the right cause, an action that names the real lever, and a
   retry/no-retry decision that matches whether retrying can help.

   Exit status is non-zero if any check fails.
   ========================================================================== */

import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const Diagnose = require("../media-diagnosis.js");

let failures = 0;
let checks = 0;

function check(name, fn) {
  checks++;
  try {
    fn();
    console.log("  ok   " + name);
  } catch (err) {
    failures++;
    console.log("  FAIL " + name + "\n       " + String(err.message).split("\n").join("\n       "));
  }
}

/* Every code the Worker emits, with the status it sends it with. */
const WORKER_CODES = [
  { code: "no_signing_key", status: 500 },
  { code: "origin_not_allowed", status: 403 },
  { code: "expired", status: 403 },
  { code: "missing_expiry", status: 403 },
  { code: "bad_signature", status: 403 },
  { code: "not_found", status: 404 },
  { code: "b2_rejected_key", status: 401 },
  { code: "b2_unreachable", status: 502 },
  { code: "bad_path", status: 400 },
  { code: "method_not_allowed", status: 405 },
  { code: "unauthorized", status: 401 }
];

console.log("\nEvery Worker code has its own explanation");

check("the table covers every code this suite knows about", () => {
  const missing = WORKER_CODES.map((entry) => entry.code)
    .filter((code) => !Diagnose.codes.includes(code));
  assert.deepEqual(missing, [], "codes with no explanation: " + missing.join(", "));
});

check("no two codes collapse onto the same headline", () => {
  const titles = WORKER_CODES.map((entry) => Diagnose.explain(entry).title);
  assert.equal(new Set(titles).size, titles.length,
    "two codes share a headline, so one of them is unreachable advice: " + titles.join(" | "));
});

check("no code falls through to the generic message", () => {
  const generic = [
    Diagnose.explain({ status: 500 }).title,
    Diagnose.explain({ status: 403, stage: "signing" }).title,
    Diagnose.explain({}).title
  ];
  for (const entry of WORKER_CODES) {
    const answer = Diagnose.explain(entry);
    assert.ok(!generic.includes(answer.title),
      entry.code + " fell through to " + JSON.stringify(answer.title));
  }
});

check("the raw code is kept for whoever runs the site, and out of the prose", () => {
  for (const entry of WORKER_CODES) {
    const answer = Diagnose.explain(entry);
    assert.ok(answer.operator.includes(entry.code), entry.code + ": the operator line lost the code");
    assert.ok(answer.operator.includes("HTTP " + entry.status), entry.code + ": the operator line lost the status");
    assert.ok(!/_[a-z]/.test(answer.title), entry.code + ": the headline leaks a machine code");
    assert.ok(!/_[a-z]/.test(answer.detail), entry.code + ": the detail leaks a machine code");
  }
});

console.log("\nThe advice points at the real lever");

check("a missing signing key names MEDIA_SIGNING_KEY", () => {
  assert.match(Diagnose.explain({ code: "no_signing_key", status: 500 }).hint, /MEDIA_SIGNING_KEY/);
});

check("a refused origin names SITE_ORIGINS", () => {
  assert.match(Diagnose.explain({ code: "origin_not_allowed", status: 403 }).hint, /SITE_ORIGINS/);
});

check("a changed signing key points at MEDIA_SIGNING_KEY too", () => {
  assert.match(Diagnose.explain({ code: "bad_signature", status: 403 }).hint, /MEDIA_SIGNING_KEY/);
});

check("an unreachable bucket names BUCKET_NAME and the preflight", () => {
  const hint = Diagnose.explain({ code: "b2_unreachable", status: 502 }).hint;
  assert.match(hint, /BUCKET_NAME/);
  assert.match(hint, /b2-check/, "the surest way to find the wrong setting is not mentioned");
});

check("a rejected key names both Worker secrets", () => {
  const hint = Diagnose.explain({ code: "b2_rejected_key", status: 401 }).hint;
  assert.match(hint, /B2_KEY_ID/);
  assert.match(hint, /B2_APPLICATION_KEY/);
});

check("a missing file names the path it looked for", () => {
  const answer = Diagnose.explain({ code: "not_found", status: 404, path: "hls/clip/segment_000.m4s" });
  assert.match(answer.detail, /hls\/clip\/segment_000\.m4s/);
});

check("a refused origin names the calling origin", () => {
  const answer = Diagnose.explain({ code: "origin_not_allowed", status: 403, origin: "https://esmeringhoy.eu.cc" });
  assert.match(answer.detail, /https:\/\/esmeringhoy\.eu\.cc/);
});

check("every answer ends with somewhere to read more", () => {
  const inputs = WORKER_CODES
    .concat([{ status: 0 }, { status: 500 }, { mediaErrorCode: 4 }, { hlsDetails: "fragLoadError" }]);
  for (const input of inputs) {
    const answer = Diagnose.explain(input);
    assert.match(answer.hint, /docs\/DEPLOY\.md/, JSON.stringify(input) + " has no pointer to the docs");
    assert.ok(answer.title.length > 0 && answer.detail.length > 0, JSON.stringify(input) + " has an empty field");
  }
});

console.log("\nRetrying is advised only when retrying can work");

check("an expired link is worth retrying, a missing file is not", () => {
  assert.equal(Diagnose.explain({ code: "expired", status: 403 }).retry, true);
  assert.equal(Diagnose.explain({ code: "not_found", status: 404 }).retry, false);
});

check("configuration mistakes are not presented as retryable", () => {
  for (const code of ["no_signing_key", "origin_not_allowed", "b2_rejected_key", "bad_path"]) {
    assert.equal(Diagnose.explain({ code }).retry, false, code + " tells the viewer to try again, which cannot help");
  }
});

console.log("\nFailures that never reach the network");

check("the four MediaError codes each say something distinct", () => {
  const titles = [1, 2, 3, 4].map((code) => Diagnose.explain({ mediaErrorCode: code }).title);
  assert.equal(new Set(titles).size, 4, "two element error codes share a headline: " + titles.join(" | "));
  assert.match(titles[2], /decod/i, "a decode failure should say so");
});

check("a file that arrived intact but would not play is called a decode problem", () => {
  const answer = Diagnose.explain({ status: 200, mediaErrorCode: 3 });
  assert.match(answer.title, /decod/i, "a 200 followed by an element error is a decoding failure");
});

check("hls.js detail beats the element's generic number", () => {
  const answer = Diagnose.explain({ status: 0, hlsDetails: "manifestParsingError", mediaErrorCode: 4 });
  assert.match(answer.title, /playlist/i, "the more specific cause was ignored");
});

console.log("\nAnswers when there is little to go on");

check("no answer at all is described as unreachable, not as a server error", () => {
  const answer = Diagnose.explain({ status: 0 });
  assert.match(answer.title, /reach/i);
  assert.equal(answer.retry, true);
});

check("a 5xx with no code is still a server-side problem", () => {
  const answer = Diagnose.explain({ status: 503 });
  assert.match(answer.title, /server/i);
  assert.equal(answer.status, 503);
});

check("the signing stage gets signing advice, not playback advice", () => {
  const answer = Diagnose.explain({ status: 403, stage: "signing" });
  assert.match(answer.title, /link/i, "a refused token request was described as a playback failure");
  assert.equal(answer.stage, "signing");
});

check("an answer the browser withheld is not blamed on the viewer's connection", () => {
  const blocked = Diagnose.explain({ status: 0, corsBlocked: true });
  assert.match(blocked.title, /not allowed/i, "a CORS refusal was reported as unreachable");
  assert.match(blocked.detail, /browser/i, "the browser's part in the refusal is not explained");
  assert.match(blocked.hint, /SITE_ORIGINS/);
  assert.equal(blocked.retry, false, "retrying cannot fix an allowlist");
  assert.match(blocked.operator, /CORS/);
});

check("a genuinely unreachable server still says so", () => {
  const offline = Diagnose.explain({ status: 0, corsBlocked: false });
  assert.match(offline.title, /reach/i);
  assert.equal(offline.retry, true);
});

check("an HTTP status outranks the CORS hint", () => {
  /* A status the page could read means nothing was withheld, so the allowlist
     framing would be wrong advice. */
  const answer = Diagnose.explain({ status: 502, code: "b2_unreachable", corsBlocked: true });
  assert.match(answer.hint, /BUCKET_NAME/);
});

check("an empty input still produces a usable answer", () => {
  const answer = Diagnose.explain({});
  assert.ok(answer.title.length > 0);
  assert.ok(answer.hint.length > 0);
  assert.ok(answer.retry === true || answer.retry === false);
});

check("the diagnostics survive an unexpected shape", () => {
  for (const odd of [{ code: null }, { code: "B2_UNREACHABLE", status: "502" }, { status: "not-a-number" }]) {
    const answer = Diagnose.explain(odd);
    assert.ok(typeof answer.title === "string" && answer.title.length > 0,
      "no answer for " + JSON.stringify(odd));
  }
  /* Codes arrive lowercase from the Worker, but a hand-typed one should not
     silently miss the table. */
  assert.match(Diagnose.explain({ code: "B2_UNREACHABLE", status: 502 }).hint, /b2-check/);
});

console.log("\n" + (failures ? "FAILED" : "PASSED") + " — " + (checks - failures) + "/" + checks + " checks\n");
process.exit(failures ? 1 : 0);
