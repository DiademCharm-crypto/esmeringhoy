/* ============================================================================
   ESMERINGHOY — SHARED HELPERS
   ----------------------------------------------------------------------------
   Presentation helpers used by index.html, player.html and admin.html.
   The clip DATA lives in catalog.js, not here, so the admin panel can
   regenerate your catalog without touching any code.

   Load order: catalog.js -> data.js -> store.js -> agegate.js

   Media resolution, in one place:
     catalog.js says a clip plays "clips/scene-01.mp4" or an m3u8 ladder.
     ESMERINGHOY_MEDIA.b2BaseUrl says where that lives (B2, or your Cloudflare
     Worker). ESMERINGHOY_MEDIA.signEndpoint, when set, means the base refuses
     unsigned requests, so URLs are exchanged for short-lived signed ones.
   ========================================================================== */

window.eshByCategory = function (category) {
  var videos = window.ESMERINGHOY_VIDEOS || [];
  if (!category || category === "Home") return videos;
  return videos.filter(function (v) {
    return (v.tags || []).indexOf(category) !== -1;
  });
};

window.eshMediaSettings = function () {
  return window.ESMERINGHOY_MEDIA || {};
};

/* Turns any stored media value into a browser-loadable URL.
   A value that is not already a URL resolves against the playback base.

   A leading slash means "a file this site serves itself" — a thumbnail that
   ships with the pages rather than sitting in the bucket. Those never touch the
   playback base, so they keep working before any storage is configured. */
window.eshMediaUrlFor = function (value) {
  if (!value) return null;
  var path = String(value);
  if (/^https?:\/\//i.test(path)) return path;
  if (path.charAt(0) === "/") return path;

  var base = window.eshMediaSettings().b2BaseUrl || "";
  if (!base) return path;
  return String(base).replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
};

/* The bucket-relative key for a stored media value, or null when the value
   points somewhere we do not control (so nothing should be signed for it).

   Root-relative values are site files, not bucket keys — signing one would ask
   storage for an object that was never uploaded there and turn a perfectly good
   thumbnail into a 404. */
window.eshMediaKeyFor = function (value) {
  if (!value) return null;
  var path = String(value);
  if (path.charAt(0) === "/") return null;
  if (!/^https?:\/\//i.test(path)) return path.replace(/^\/+/, "");

  var base = (window.eshMediaSettings().b2BaseUrl || "").replace(/\/+$/, "");
  if (base && path.indexOf(base + "/") === 0) {
    return path.slice(base.length + 1).replace(/^\/+/, "");
  }
  return null;
};

window.eshMediaUrl = function (video) {
  if (!video) return null;
  var path = video.video;

  /* Graceful fallback so catalogs written before the direct-video switch
     still play instead of silently breaking. */
  if (!path) {
    if (Array.isArray(video.sources) && video.sources.length) path = video.sources[0].url;
    else if (video.embedUrl) path = video.embedUrl;
  }
  return window.eshMediaUrlFor(path);
};

window.eshMediaKey = function (video) {
  if (!video) return null;
  var path = video.video;
  if (!path) {
    if (Array.isArray(video.sources) && video.sources.length) path = video.sources[0].url;
    else if (video.embedUrl) path = video.embedUrl;
  }
  return window.eshMediaKeyFor(path);
};

/* True when the clip points at an HLS playlist rather than a plain file. */
window.eshIsHls = function (url) {
  return /\.m3u8($|\?)/i.test(url || "");
};

/* ------------------------------------------------------- clips + gallery -- */

/* Every playable part of a title, in order, as { label, video }.

   A title with more than one file lists them in `clips` and the player turns
   them into buttons under the video. `video` is still the primary clip, so
   cards, links and any older page keep working; when `clips` is missing this
   falls back to that one file. */
window.eshClips = function (video) {
  if (!video) return [];

  var out = [];
  (video.clips || []).forEach(function (clip) {
    var value = typeof clip === "string" ? clip : (clip && clip.video);
    if (!value) return;
    var label = (clip && clip.label) || ("Clip " + (out.length + 1));
    out.push({ label: String(label), video: value });
  });

  if (!out.length && video.video) out.push({ label: "Clip 1", video: video.video });
  return out;
};

/* Photos attached to a title, in the order they should be shown. */
window.eshGallery = function (video) {
  if (!video || !Array.isArray(video.gallery)) return [];
  return video.gallery.filter(function (value) { return Boolean(value); });
};

/* ---------------------------------------------------------------- signing -- */

function signEndpoint() {
  var settings = window.eshMediaSettings();
  return settings.signEndpoint || "";
}

/* True when this deployment delivers media through a Worker that requires a
   signature. Without a sign endpoint everything stays on plain URLs, so a
   public bucket keeps working exactly as before. */
window.eshSigningEnabled = function () {
  return Boolean(signEndpoint());
};

/* The signature a key was issued with, kept so a view can be reported against
   the same credential the player was given. Later exchanges add to this map
   rather than replace it (the homepage signs thumbnails after a player has
   already signed its clip), and entries are dropped once they expire. */
var issuedTokens = {};

/* Why the last signing attempt failed, or null. The player cannot tell the
   difference between a refused origin, a Worker with no signing key and a
   network drop from the fetch result alone, so the reason is kept here for it
   to show — see media-diagnosis.js. */
var lastSigningFailure = null;

window.eshLastSigningFailure = function () {
  return lastSigningFailure;
};

/* Could this URL be reached at all? A bare HEAD: no credentials, no custom
   headers, so the browser sends it cross-origin without a preflight and it
   settles for any answer — including one this page is not allowed to read.
   That is the only way to tell "the server is not there" from "the server
   answered and the browser withheld it", which are different problems with
   different fixes. Nothing is downloaded. */
window.eshReachable = function (url) {
  if (!url || typeof fetch !== "function") return Promise.resolve(false);
  return fetch(url, { method: "HEAD", mode: "no-cors", credentials: "omit", cache: "no-store" })
    .then(function () { return true; })
    .catch(function () { return false; });
};

window.eshTokenFor = function (key) {
  var token = issuedTokens[key];
  if (!token) return null;
  if (Number(token.exp) * 1000 < Date.now()) {
    delete issuedTokens[key];
    return null;
  }
  return token;
};

/* Exchanges bucket keys for signed URLs, in one round trip for as many keys as
   you like. Resolves to a map; unresolved keys are simply absent, and callers
   fall back to the unsigned URL. */
window.eshSignedUrls = function (keys) {
  var wanted = (keys || []).filter(Boolean);
  var endpoint = signEndpoint();
  if (!endpoint || !wanted.length) return Promise.resolve({});
  if (typeof fetch !== "function") return Promise.resolve({});

  var query = wanted.map(function (key) { return "p=" + encodeURIComponent(key); }).join("&");
  var url = endpoint + (endpoint.indexOf("?") === -1 ? "?" : "&") + query;

  lastSigningFailure = null;

  return fetch(url, { credentials: "omit" })
    .then(function (response) {
      if (!response.ok) {
        /* The Worker's error body names the cause (origin_not_allowed,
           no_signing_key, …) — carry it, rather than only the status, so the
           player has something true to say. */
        return response.json().catch(function () { return {}; }).then(function (body) {
          var problem = new Error(body.message || ("token endpoint answered HTTP " + response.status));
          problem.status = response.status;
          problem.code = body.error || null;
          throw problem;
        });
      }
      return response.json();
    })
    .then(function (data) {
      var out = {};
      pruneTokens();
      if (data && data.urls) {
        Object.keys(data.urls).forEach(function (key) {
          out[key] = absoluteAgainst(endpoint, data.urls[key]);
        });
      } else if (data && data.url && wanted.length === 1) {
        out[wanted[0]] = absoluteAgainst(endpoint, data.url);
      }
      Object.keys(out).forEach(function (key) {
        issuedTokens[key] = signatureOf(out[key]);
      });
      return out;
    })
    .catch(function (err) {
      /* Usually a missing SITE_ORIGINS entry or a wrong sign endpoint. Falling
         back to the plain URL keeps a public setup working; a private one will
         answer 403, which is the honest outcome — and the reason travels with
         it so the player can say which of those it is. */
      var failure = {
        status: (err && err.status) || 0,
        code: (err && err.code) || null,
        message: (err && err.message) || String(err)
      };
      console.warn("Could not fetch signed media URLs:", err);

      if (failure.status) {
        lastSigningFailure = failure;
        return {};
      }

      /* No status means fetch() rejected before any answer was readable, which
         covers both "nothing is listening" and "the answer was withheld". The
         probe settles it, and it has to settle *before* this resolves so the
         player explains the right one. */
      return window.eshReachable(endpoint).then(function (answered) {
        if (answered) {
          failure.corsBlocked = true;
          console.warn("The sign endpoint answered, but this page was not allowed to read " +
            "it — if the endpoint is a Worker, add " + window.location.origin + " to SITE_ORIGINS.");
        }
        lastSigningFailure = failure;
        return {};
      });
    });
};

function pruneTokens() {
  var now = Date.now();
  Object.keys(issuedTokens).forEach(function (key) {
    if (Number(issuedTokens[key].exp) * 1000 < now) delete issuedTokens[key];
  });
}

/* Pulls ?e= and ?s= back out of a signed URL, for callers that must prove they
   hold a link this Worker issued (the tracking beacon does). */
function signatureOf(url) {
  try {
    var parsed = new URL(url, window.location.href);
    var exp = parsed.searchParams.get("e");
    var sig = parsed.searchParams.get("s");
    return exp && sig ? { exp: exp, sig: sig, url: url } : null;
  } catch (e) {
    return null;
  }
}

function absoluteAgainst(endpoint, value) {
  try {
    return new URL(value, new URL(endpoint, window.location.href).origin).href;
  } catch (e) {
    return value;
  }
}

/* Single-clip convenience wrapper used by the player. */
window.eshSignedMediaUrl = function (video) {
  var plain = window.eshMediaUrl(video);
  var key = window.eshMediaKey(video);
  if (!plain || !key || !window.eshSigningEnabled()) return Promise.resolve(plain);

  return window.eshSignedUrls([key]).then(function (map) {
    return map[key] || plain;
  });
};

/* A 1x1 transparent GIF. When media needs signing, a thumbnail's real URL
   cannot be known until the token request comes back — and pointing an <img>
   at the unsigned URL first would fire a request the Worker answers with 403. */
window.eshPlaceholderPixel =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/* What to put in <img src> right now for a clip's thumbnail, plus the key to
   swap in a signed URL for once it arrives. */
window.eshPosterStart = function (video) {
  var key = video.poster ? window.eshMediaKeyFor(video.poster) : null;
  if (key && window.eshSigningEnabled()) {
    return { src: window.eshPlaceholderPixel, key: key, pending: true };
  }
  return { src: window.eshPoster(video), key: key, pending: false };
};

/* ---------------------------------------------------------------- formatting */

window.eshViews = function (n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};

window.eshAgo = function (iso) {
  var days = Math.floor((Date.now() - new Date(iso + "T00:00:00Z").getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return days + " days ago";
  var months = Math.round(days / 30);
  return months + (months === 1 ? " month ago" : " months ago");
};

(function () {
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* Generates an offline, SFW placeholder thumbnail as an SVG data URI.
     A real poster (including one uploaded from the admin panel, which is stored
     as a bucket-relative path) resolves against the playback base. */
  window.eshPoster = function (video) {
    if (video.poster) {
      var resolved = window.eshMediaUrlFor(video.poster);
      if (resolved) return resolved;
    }
    var seed = 0;
    for (var i = 0; i < video.id.length; i++) seed = (seed * 31 + video.id.charCodeAt(i)) % 100000;
    /* Golden-angle step so sequential ids spread evenly around the wheel. */
    var h1 = Math.round((seed * 137.508) % 360);
    var h2 = (h1 + 55) % 360;
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="hsl(' + h1 + ',48%,24%)"/>' +
      '<stop offset="1" stop-color="hsl(' + h2 + ',42%,10%)"/>' +
      '</linearGradient></defs>' +
      '<rect width="640" height="360" fill="url(#g)"/>' +
      '<circle cx="320" cy="150" r="46" fill="rgba(255,255,255,0.10)"/>' +
      '<path d="M305 128 L305 172 L345 150 Z" fill="rgba(255,255,255,0.75)"/>' +
      '<text x="320" y="248" font-family="Segoe UI,Arial,sans-serif" font-size="26" ' +
      'font-weight="700" fill="#ffffff" fill-opacity="0.92" text-anchor="middle">' +
      esc(video.title) + '</text>' +
      '</svg>';
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  };
})();
