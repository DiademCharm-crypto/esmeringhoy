/* ============================================================================
   ESMERINGHOY — AWS SIGNATURE VERSION 4 (presigning)
   ----------------------------------------------------------------------------
   Backblaze B2's *native* API cannot be called from a browser: B2 denies CORS
   preflights for b2_authorize_account / b2_get_upload_url, so an upload can
   never be started from a web page. The S3-compatible API is different — it
   supports presigned URLs, and a presigned URL is just math, which means the
   browser can create one itself without any server in between.

   That is the whole reason this file exists: the admin panel signs its own
   "PUT this object" URLs with the application key you paste in, then uploads
   the file straight to B2. Nothing is proxied and no secret is sent anywhere.
   The object is uploaded as UNSIGNED-PAYLOAD, so the browser never has to read
   the video to hash it — which is what makes multi-gigabyte uploads practical.

   Load order: classic script (works on file://), assigns window.EshSigV4.
   Node tools require() this same file, so one implementation is shared and
   verified once — see tools/sigv4.test.mjs.

   API:
     EshSigV4.objectUrl(endpoint, bucket, key)          -> https URL string
     EshSigV4.presignUrl(options)                       -> Promise<{url, ...}>
     EshSigV4.signRequest(options)                      -> Promise<{authorization,...}>
     EshSigV4.uriEncode(value, encodeSlash)
     EshSigV4.sha256Hex(text)
   ========================================================================== */

(function (root) {
  "use strict";

  var ALGORITHM = "AWS4-HMAC-SHA256";
  var UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

  /* Hash of the empty string — used when signing header-auth requests with no body. */
  var EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  var encoder = new TextEncoder();

  function cryptoObj() {
    var c = root.crypto || (typeof crypto !== "undefined" ? crypto : null);
    if (!c || !c.subtle) {
      throw new Error("WebCrypto is unavailable here. Open the admin panel over " +
        "https://, http://localhost or file:// — signing needs a secure context.");
    }
    return c;
  }

  function toBytes(input) {
    return typeof input === "string" ? encoder.encode(input) : input;
  }

  function toHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    }
    return out;
  }

  function hmac(keyBytes, message) {
    return cryptoObj().subtle
      .importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      .then(function (key) {
        return cryptoObj().subtle.sign("HMAC", key, toBytes(message));
      });
  }

  function sha256Hex(message) {
    return cryptoObj().subtle
      .digest("SHA-256", toBytes(message))
      .then(toHex);
  }

  /* AWS UriEncode. The platform's encodeURIComponent() is *not* a substitute:
     it leaves ! ' ( ) * unencoded, which changes the signature. */
  function uriEncode(value, encodeSlash) {
    var chars = Array.from(String(value));
    var out = "";
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      var code = ch.codePointAt(0);
      var unreserved =
        (code >= 0x41 && code <= 0x5a) || /* A-Z */
        (code >= 0x61 && code <= 0x7a) || /* a-z */
        (code >= 0x30 && code <= 0x39) || /* 0-9 */
        ch === "-" || ch === "_" || ch === "." || ch === "~";

      if (unreserved) {
        out += ch;
      } else if (ch === "/") {
        out += encodeSlash ? "%2F" : "/";
      } else {
        var bytes = encoder.encode(ch);
        for (var b = 0; b < bytes.length; b++) {
          out += "%" + (bytes[b] < 16 ? "0" : "") + bytes[b].toString(16).toUpperCase();
        }
      }
    }
    return out;
  }

  function canonicalQueryString(pairs) {
    return pairs
      .map(function (pair) {
        return [uriEncode(pair[0], true), uriEncode(pair[1] == null ? "" : pair[1], true)];
      })
      .sort(function (a, b) {
        if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
        if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
        return 0;
      })
      .map(function (pair) { return pair[0] + "=" + pair[1]; })
      .join("&");
  }

  /* 20130524T000000Z */
  function amzDate(date) {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  }

  function signingKey(secretAccessKey, dateStamp, region, service) {
    return hmac(encoder.encode("AWS4" + secretAccessKey), dateStamp)
      .then(function (kDate) { return hmac(kDate, region); })
      .then(function (kRegion) { return hmac(kRegion, service); })
      .then(function (kService) { return hmac(kService, "aws4_request"); });
  }

  function finish(parts) {
    var dateStamp = parts.amzDate.slice(0, 8);
    var scope = [dateStamp, parts.region, parts.service, "aws4_request"].join("/");
    var stringToSign = [ALGORITHM, parts.amzDate, scope, parts.canonicalRequestHash].join("\n");

    return signingKey(parts.secretAccessKey, dateStamp, parts.region, parts.service)
      .then(function (key) { return hmac(key, stringToSign); })
      .then(function (signature) {
        return {
          signature: toHex(signature),
          stringToSign: stringToSign,
          scope: scope,
          credential: parts.accessKeyId + "/" + scope,
          canonicalRequest: parts.canonicalRequest
        };
      });
  }

  /* Path-style object URL. Backblaze supports both path-style and
     virtual-hosted-style; path-style keeps the region and the bucket name in
     obvious places, which makes misconfiguration easy to spot. */
  function objectUrl(endpoint, bucket, key) {
    return String(endpoint).replace(/\/+$/, "") +
      "/" + uriEncode(bucket, false) +
      "/" + uriEncode(key, false);
  }

  /* Creates a presigned URL: the credential travels in the query string, so no
     Authorization header is needed and <video>/fetch can use it directly. */
  function presignUrl(options) {
    var method = String(options.method || "GET").toUpperCase();
    var region = options.region;
    var service = options.service || "s3";
    var date = options.date ? new Date(options.date) : new Date();
    var stamp = amzDate(date);
    var expiresIn = Math.min(Math.max(Number(options.expiresIn) || 900, 1), 604800);
    var bucket = options.bucket;
    var key = options.key;

    var canonicalUri = "/" + uriEncode(bucket, false) + "/" + uriEncode(key, false);
    var host = String(options.endpoint).replace(/^https?:\/\//, "").replace(/\/+$/, "");

    var signedHeaders = "host";
    var canonicalHeaders = "host:" + host + "\n";

    var query = (options.extraQuery || []).concat([
      ["X-Amz-Algorithm", ALGORITHM],
      ["X-Amz-Credential", options.accessKeyId + "/" + stamp.slice(0, 8) + "/" + region + "/" + service + "/aws4_request"],
      ["X-Amz-Date", stamp],
      ["X-Amz-Expires", String(expiresIn)],
      ["X-Amz-SignedHeaders", signedHeaders]
    ]);

    var canonicalQuery = canonicalQueryString(query);
    var canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      UNSIGNED_PAYLOAD
    ].join("\n");

    return sha256Hex(canonicalRequest).then(function (canonicalRequestHash) {
      return finish({
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        region: region,
        service: service,
        amzDate: stamp,
        canonicalRequest: canonicalRequest,
        canonicalRequestHash: canonicalRequestHash
      });
    }).then(function (signed) {
      return {
        url: String(options.endpoint).replace(/\/+$/, "") + canonicalUri +
          "?" + canonicalQuery + "&X-Amz-Signature=" + signed.signature,
        host: host,
        method: method,
        expiresIn: expiresIn,
        expiresAt: new Date(date.getTime() + expiresIn * 1000),
        canonicalRequest: signed.canonicalRequest,
        stringToSign: signed.stringToSign,
        signature: signed.signature,
        credential: signed.credential
      };
    });
  }

  /* Header-based signing. The admin panel doesn't need it, but keeping it here
     means the AWS published test vectors (which use headers) can be checked
     against this exact implementation — see tools/sigv4.test.mjs. */
  function signRequest(options) {
    var method = String(options.method || "GET").toUpperCase();
    var service = options.service || "s3";
    var date = options.date ? new Date(options.date) : new Date();
    var stamp = amzDate(date);
    var url = new URL(options.url);
    var headers = options.headers || {};
    var payloadHash = options.payloadHash || EMPTY_SHA256;

    var lower = function (name) { return String(name).toLowerCase(); };
    var merged = {};
    Object.keys(headers).forEach(function (name) { merged[lower(name)] = String(headers[name]).trim(); });
    merged.host = url.host;
    merged["x-amz-date"] = stamp;
    merged["x-amz-content-sha256"] = payloadHash;

    var names = Object.keys(merged).sort();
    var canonicalHeaders = names.map(function (n) { return n + ":" + merged[n] + "\n"; }).join("");
    var signedHeaders = names.join(";");

    var canonicalUri = "/" + uriEncode(decodeURIComponent(url.pathname).replace(/^\//, ""), false);
    var pairs = [];
    url.searchParams.forEach(function (value, name) { pairs.push([name, value]); });

    var canonicalRequest = [
      method,
      canonicalUri,
      canonicalQueryString(pairs),
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");

    return sha256Hex(canonicalRequest).then(function (canonicalRequestHash) {
      return finish({
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        region: options.region,
        service: service,
        amzDate: stamp,
        canonicalRequest: canonicalRequest,
        canonicalRequestHash: canonicalRequestHash
      });
    }).then(function (signed) {
      return {
        authorization: ALGORITHM + " Credential=" + signed.credential +
          ",SignedHeaders=" + signedHeaders + ",Signature=" + signed.signature,
        signedHeaders: signedHeaders,
        canonicalRequest: signed.canonicalRequest,
        stringToSign: signed.stringToSign,
        signature: signed.signature
      };
    });
  }

  var api = {
    ALGORITHM: ALGORITHM,
    UNSIGNED_PAYLOAD: UNSIGNED_PAYLOAD,
    EMPTY_SHA256: EMPTY_SHA256,
    objectUrl: objectUrl,
    presignUrl: presignUrl,
    signRequest: signRequest,
    uriEncode: uriEncode,
    canonicalQueryString: canonicalQueryString,
    sha256Hex: sha256Hex,
    toHex: toHex,
    amzDate: amzDate
  };

  root.EshSigV4 = api;

  /* Also loadable from Node (tools/ and the test suite) without a bundler. */
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
