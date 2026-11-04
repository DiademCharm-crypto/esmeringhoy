/* ============================================================================
   ESMERINGHOY — PLAIN-LANGUAGE MEDIA DIAGNOSIS
   ----------------------------------------------------------------------------
   Turns a failure — an HTTP status, one of the Worker's error codes, or a
   <video> element's own error number — into a sentence a person can act on.

   Why it exists: every distinct way playback can fail looks identical on the
   page. A private bucket whose Worker keys were rotated, a sign endpoint that
   is not in SITE_ORIGINS, a clip whose path is misspelled, a Worker with no
   signing key and a Worker that cannot reach Backblaze all present the same
   stalled player, and the only description of the cause sits in a JSON body
   that the <video> element never shows. Each of them is one line to fix once
   you know which one it is, so this file is the mapping from "it did not play"
   to "here is which one it is".

   Nothing here touches the DOM, so the whole table is exercised by
   tools/media-diagnosis.test.mjs — including codes that are awkward to
   reproduce locally, like a Worker with no signing key.

   API
     EshDiagnose.explain({
       status          HTTP status, 0 for "no answer at all"
       code            the Worker's `error` field, e.g. "b2_unreachable"
       message         the Worker's `message`, shown to whoever runs the site
       path            bucket path, when the failure names one
       origin          the page's origin, for the origin allowlist case
       mediaErrorCode  MediaError.code from the <video> element (1-4)
       hlsDetails      hls.js error detail, e.g. "manifestParsingError"
       stage           "signing" (no signed URL) or "playback" (default)
     }) -> { title, detail, hint, operator, code, status, retry, stage }
   ========================================================================== */

(function (root) {
  "use strict";

  var SCRIPT_HELP = "docs/DEPLOY.md has the walkthrough.";

  /* -------------------------------------------------------------- the table --
     `retry` means reloading or retrying genuinely has a chance of succeeding:
     an expired link gets a new one, a refused key does not. */

  var CODES = {
    no_signing_key: {
      title: "Video links are not set up yet",
      detail: "The server that hands out video links has no signing key, so it cannot " +
        "issue a playable URL for anything.",
      hint: "On the Worker: npx wrangler secret put MEDIA_SIGNING_KEY, then deploy.",
      retry: false
    },

    origin_not_allowed: {
      title: "This address is not allowed to load videos",
      detail: "The video server refused to issue a link for this page: the address it is " +
        "being called from is not on its allowlist.",
      hint: "Add this page's origin to SITE_ORIGINS on the Worker, then deploy. " +
        "Both the bare and the www address need their own entry.",
      retry: false
    },

    expired: {
      title: "This video link has expired",
      detail: "Links are deliberately short-lived, so a tab left open — or a link copied " +
        "and pasted — stops working after a while.",
      hint: "Reload the video to get a fresh link.",
      retry: true
    },

    missing_expiry: {
      title: "The video link was incomplete",
      detail: "The player was given a link with no expiry on it, and the server will not " +
        "serve media without one.",
      hint: "Reload the page. If it keeps happening, this clip's URL is being served by " +
        "something other than the Worker.",
      retry: true
    },

    bad_signature: {
      title: "The video link was rejected",
      detail: "The link this page was given does not match what the server expects — " +
        "usually because the signing key changed after the page loaded.",
      hint: "Reload the page. If it fails straight away again, the Worker's " +
        "MEDIA_SIGNING_KEY was changed and the published catalog needs a redeploy.",
      retry: true
    },

    not_found: {
      title: "The video file is missing",
      detail: "The link was accepted, but there is no file at that path in the bucket.",
      hint: "Compare the clip's Video URL with the file's path in Backblaze — the prefix " +
        "and the spelling both have to match exactly.",
      retry: false
    },

    b2_rejected_key: {
      title: "The video server was turned away by storage",
      detail: "The video server reached Backblaze and was refused, so it cannot read any file.",
      hint: "Check B2_KEY_ID and B2_APPLICATION_KEY on the Worker, and that the key is " +
        "scoped to this bucket.",
      retry: false
    },

    b2_unreachable: {
      title: "The video server cannot reach storage",
      detail: "The site itself is fine, but the server that streams video could not talk to " +
        "Backblaze — usually because its bucket name or keys are missing or wrong.",
      hint: "Set BUCKET_NAME and a valid key pair on the Worker. " +
        "node tools/b2-check.mjs reports which one is wrong, before you deploy.",
      retry: true
    },

    bad_path: {
      title: "This clip has no video configured",
      detail: "No file path was sent to the video server, so there is nothing to play.",
      hint: "Add the Video URL in the admin panel, then publish catalog.js.",
      retry: false
    },

    method_not_allowed: {
      title: "The video server refused that request",
      detail: "The server understood the address but not the kind of request made to it.",
      hint: "Reload the page. If it persists, the sign endpoint and the Worker disagree " +
        "about which routes exist.",
      retry: true
    },

    unauthorized: {
      title: "The video server refused the request",
      detail: "The server asked for a credential the page does not have.",
      hint: "Check that the clip's media points at the Worker's /token and media routes, " +
        "not at a password-protected one.",
      retry: false
    }
  };

  /* The <video> element's own numbers, used when the probe cannot get an HTTP
     answer — a codec problem never reaches the network at all. */
  var MEDIA_ERRORS = {
    1: {
      title: "Playback was interrupted",
      detail: "The browser stopped the download before it finished.",
      hint: "Try again; if it keeps happening on one clip only, that file is worth re-encoding.",
      retry: true
    },
    2: {
      title: "The connection to the video server dropped",
      detail: "The file started arriving and then the transfer stopped.",
      hint: "Check the connection and reload. A clip that always fails part-way through is " +
        "usually a truncated upload.",
      retry: true
    },
    3: {
      title: "This file could not be decoded",
      detail: "The data arrived, but it is not video the browser can decode — a corrupt " +
        "file or an unsupported codec.",
      hint: "Re-encode it (tools/hls-encode.sh) and upload again.",
      retry: false
    },
    4: {
      title: "This file cannot be played here",
      detail: "The address did not produce a playable video — a wrong path, a file that is " +
        "not media, or a format this browser does not support.",
      hint: "Check the clip's Video URL, then confirm the file plays when opened directly.",
      retry: false
    }
  };

  /* hls.js is more specific than the element is, so it is consulted first. */
  var HLS_DETAILS = {
    manifestParsingError: {
      title: "The playlist could not be read",
      detail: "The address returned something that is not a valid HLS playlist.",
      hint: "Check that the clip points at the master .m3u8 and that the upload finished.",
      retry: false
    },
    manifestLoadError: {
      title: "The playlist could not be downloaded",
      detail: "The master playlist was requested and did not come back.",
      hint: "Reload. If it persists, the playlist's path in the bucket is wrong.",
      retry: true
    },
    levelLoadError: {
      title: "One quality level could not be loaded",
      detail: "The master playlist pointed at a stream playlist that could not be fetched.",
      hint: "Upload the whole ladder — every stream folder listed in the master playlist.",
      retry: true
    },
    fragLoadError: {
      title: "Part of the video could not be downloaded",
      detail: "A segment of the stream is missing or was refused.",
      hint: "Re-upload the ladder; a partial upload is the usual cause.",
      retry: true
    },
    fragParsingError: {
      title: "Part of the video could not be read",
      detail: "A segment arrived but is not usable media data.",
      hint: "The upload is probably truncated — re-upload the ladder.",
      retry: false
    }
  };

  /* Reached two ways: the Worker says the origin is not on its allowlist, or
     the browser refuses to let the page read a reply that arrived. The same
     fault, seen from either side. */
  var BROWSER_BLOCKED = {
    title: "This address is not allowed to load videos",
    detail: "The video server answered this page, but the browser was not allowed to read " +
      "the answer. That happens when this page's address is not on the server's allowlist, " +
      "or when video is requested from a different host than the site itself.",
    hint: "Add this page's origin to SITE_ORIGINS on the Worker — the bare and the www " +
      "address each need their own entry — and serve media from the same host as the site.",
    retry: false
  };

  var SIGNING_FALLBACK = {
    title: "The page could not get a video link",
    detail: "The video server was asked for a signed link and did not provide one.",
    hint: "Reload the page. If it persists, the sign endpoint is misconfigured.",
    retry: true
  };

  /* ----------------------------------------------------------------- helpers */

  function httpNote(status) {
    if (!status) return "no answer from the server";
    if (status === 403) return "the server refused the request";
    if (status === 404) return "the server has nothing at that address";
    if (status === 408 || status === 504) return "the server timed out";
    if (status === 429) return "the server is rate limiting requests";
    if (status >= 500) return "the server had a problem";
    return "the server refused the request";
  }

  function generic(status, stage) {
    if (!status) {
      return {
        title: "Could not reach the video server",
        detail: "The request never got an answer — the site may be unreachable from here, " +
          "or the network dropped it.",
        hint: "Check the connection, then reload.",
        retry: true
      };
    }
    if (status >= 500) {
      return {
        title: "The video server had a problem",
        detail: "The video server answered with an error of its own.",
        hint: "Try again in a moment. If it persists, check the Worker's logs.",
        retry: true
      };
    }
    if (status === 404) {
      return {
        title: "The video was not found",
        detail: "The server has nothing at this clip's address.",
        hint: "Check the clip's Video URL and the file's path in the bucket.",
        retry: false
      };
    }
    if (stage === "signing") return SIGNING_FALLBACK;
    return {
      title: "This video could not be loaded",
      detail: "The video server " + httpNote(status) + ".",
      hint: "Check the clip's Video URL in the admin panel, then publish catalog.js.",
      retry: true
    };
  }

  function operatorLine(input, status, code) {
    var parts = [];
    if (status) parts.push("HTTP " + status);
    if (code) parts.push(code);
    if (input.message) parts.push(String(input.message));
    if (input.hlsDetails) parts.push(String(input.hlsDetails));
    if (!parts.length && input.corsBlocked) return "the server answered but the browser could not read it (CORS)";
    if (input.corsBlocked) parts.push("response not readable by this page (CORS)");
    return parts.join(" · ");
  }

  /* ----------------------------------------------------------------- explain */

  function explain(input) {
    input = input || {};

    var status = Number(input.status) || 0;
    var code = String(input.code || "").toLowerCase();
    var stage = input.stage === "signing" ? "signing" : "playback";
    var mediaErrorCode = Number(input.mediaErrorCode) || 0;

    var chosen = null;

    if (CODES[code]) {
      chosen = CODES[code];
    } else if (!status || (status >= 200 && status < 300)) {
      /* No usable HTTP answer: either nothing was attempted (a codec failure
         never reaches the network) or the file was there and still did not
         play, which is decoding. */
      chosen = HLS_DETAILS[input.hlsDetails] || MEDIA_ERRORS[mediaErrorCode] || null;
    }

    /* No HTTP answer at all, but a separate credential-free request settled:
       the server is there and the browser is what refused to share the reply.
       Reported as an allowlist problem, because in this project that is what
       it almost always is — and "check your connection" sends the viewer
       nowhere useful. */
    if (!chosen && !status && input.corsBlocked) chosen = BROWSER_BLOCKED;

    if (!chosen) chosen = generic(status, stage);

    var detail = chosen.detail;
    if (code === "not_found" && input.path) {
      detail = "There is no file at “" + String(input.path) + "” in the bucket.";
    }
    if (code === "origin_not_allowed" && input.origin) {
      detail = "The video server refused to issue a link to " + String(input.origin) + ": that " +
        "address is not on its allowlist.";
    }

    return {
      title: chosen.title,
      detail: detail,
      hint: chosen.hint ? chosen.hint + " " + SCRIPT_HELP : SCRIPT_HELP,
      operator: operatorLine(input, status, code),
      code: code || null,
      status: status || null,
      retry: Boolean(chosen.retry),
      stage: stage
    };
  }

  var api = {
    explain: explain,
    codes: Object.keys(CODES),
    mediaErrors: Object.keys(MEDIA_ERRORS),
    hlsDetails: Object.keys(HLS_DETAILS),
    httpNote: httpNote
  };

  root.EshDiagnose = api;

  /* Loadable from Node (the test suite) without a bundler. */
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
