/* ============================================================================
   ESMERINGHOY — VIEW TRACKING CLIENT
   ----------------------------------------------------------------------------
   Reports a playback session to the CDN Worker's /track route: one request when
   a clip actually starts playing, then a heartbeat every 15 seconds while it
   plays, and one last report when the viewer leaves. That is a handful of
   requests per view, not per media request — the Cloudflare free tier covers
   this many times over (see docs/STATISTICS.md for the arithmetic).

   What is sent, in full: a random session id, the clip's bucket path, how far
   into the clip playback had reached, the clip's duration, and whether it was
   playing. Nothing else. No cookies, no fingerprint, no viewer identity. The
   Worker halts visitor IPs into a per-day salt hash before storing them, so it
   can count distinct viewers without keeping an address.

   Load order: catalog.js -> data.js -> tracker.js -> store.js -> agegate.js
   ========================================================================== */

window.EsmeringhoyTracker = (function () {
  "use strict";

  var HEARTBEAT_MS = 15000;   /* server-side ceiling: age + 50% + 10s */
  var MIN_VIEW_SECONDS = 2;   /* a bounce through the player is not a view */

  /* ------------------------------------------------------------- transmit -- */

  /* The sign endpoint lives at /token on the Worker; tracking lives beside it at
     /track. Deriving it means one setting configures both. */
  function endpoint() {
    var settings = window.eshMediaSettings ? window.eshMediaSettings() : {};
    if (settings.trackEndpoint) return settings.trackEndpoint;
    var sign = settings.signEndpoint || "";
    if (!sign) return "";
    if (/\/token\b/.test(sign)) return sign.replace(/\/token\b[^/]*$/, "/track");
    return "";
  }

  function allowed() {
    try {
      if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return false;
      if (navigator.msDoNotTrack === "1") return false;
      if (navigator.globalPrivacyControl === true) return false;
      /* The admin panel's "Don't count my own views" checkbox sets this, so
         your own test plays do not skew the numbers you are about to read. */
      if (window.localStorage && localStorage.getItem("esh_track_self") === "off") return false;
    } catch (e) { /* private mode / disabled storage: fail open */ }
    return true;
  }

  function sessionId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
      if (window.crypto && crypto.getRandomValues) {
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        var out = "";
        for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
        return out;
      }
    } catch (e) {}
    return "s" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  var warned = false;

  /* text/plain keeps this a CORS "simple" request, so no preflight is needed for
     a request that may fire every 15 seconds. The Worker parses the body as JSON
     regardless of the declared type. */
  function send(url, body, useBeacon) {
    var payload = JSON.stringify(body);
    if (useBeacon && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(url, new Blob([payload], { type: "text/plain" }))) return;
      } catch (e) {}
    }
    if (typeof fetch !== "function") return;
    fetch(url, {
      method: "POST",
      /* No credentials: the beacon carries nothing worth leaking, and the
         Worker's CORS rule does not allow credentialed requests. */
      credentials: "omit",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: payload,
      keepalive: true
    }).catch(function (err) {
      if (!warned) {
        warned = true;
        console.warn("View tracking is not reaching the Worker:", err && err.message);
      }
    });
  }

  /* ----------------------------------------------------------------- attach */

  /* Wires a <video> element to the tracking endpoint.
       getKey()  -> the clip's bucket path (the same path the signature covers)
       getToken()-> { e, s } from the signed URL this session is playing, or null
     Returns an object with `stop()` for players that swap sources in place. */
  function attach(player, getKey, getToken) {
    var url = endpoint();
    if (!player || !url || !allowed()) {
      return { stop: function () {}, active: false };
    }

    var session = sessionId();
    var started = false;
    var lastSent = 0;
    var timer = null;

    function credentials() {
      var key = getKey();
      if (!key) return null;
      var token = getToken ? getToken(key) : null;
      if (!token || !token.sig) {
        /* Signing is off (a public bucket) or the token has not arrived yet. */
        return { path: key, exp: null, sig: null, unsigned: true };
      }
      return { path: key, exp: token.exp, sig: token.sig, unsigned: false };
    }

    /* `playing` tells the Worker whether the reported position was reached by
       playing, because it only credits play time for a position that was. A
       pause or the end of a clip is exactly such a moment — the video played up
       to that position — so the flush after them must say so, or the last few
       seconds of every clip would go uncounted. */
    function report(event, playing, useBeacon) {
      var creds = credentials();
      if (!creds) return;
      lastSent = Date.now();
      send(url, {
        session: session,
        path: creds.path,
        exp: creds.exp,
        sig: creds.sig,
        event: event,
        position: Math.max(0, player.currentTime || 0),
        duration: isFinite(player.duration) && player.duration > 0 ? player.duration : null,
        playing: playing !== false
      }, useBeacon);
    }

    function startHeartbeat() {
      clearInterval(timer);
      timer = setInterval(function () {
        if (player.paused || player.ended) return;
        report("progress", true, false);
      }, HEARTBEAT_MS);
    }

    function onTimeUpdate() {
      if (started || player.paused) return;
      if (player.currentTime < MIN_VIEW_SECONDS) return;
      started = true;
      report("start", true, false);
      startHeartbeat();
    }

    function onPlay() {
      /* Resuming the same clip is the same session — the Worker keeps counting
         watch time on the row it already has. */
      if (started) startHeartbeat();
    }

    function onPause() {
      clearInterval(timer);
      /* Paused at a position the video really reached: those seconds are real
         watch time, so flush them while saying they were played. */
      if (started) report("progress", true, false);
    }

    function onEnded() {
      clearInterval(timer);
      if (started) report("end", true, false);
    }

    function onLeave() {
      clearInterval(timer);
      /* The page is going away, so a normal fetch will not survive: beacon it.
         Nothing new to credit if it was already paused — that was flushed then. */
      if (started && Date.now() - lastSent > 1000) report("progress", !player.paused, true);
    }

    player.addEventListener("timeupdate", onTimeUpdate);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("ended", onEnded);
    window.addEventListener("pagehide", onLeave);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") onLeave();
      else if (started && !player.paused) startHeartbeat();
    });

    return {
      active: true,
      session: function () { return session; },
      stop: function () {
        player.removeEventListener("timeupdate", onTimeUpdate);
        player.removeEventListener("play", onPlay);
        player.removeEventListener("pause", onPause);
        player.removeEventListener("ended", onEnded);
        window.removeEventListener("pagehide", onLeave);
        clearInterval(timer);
      }
    };
  }

  return {
    attach: attach,
    endpoint: endpoint,
    allowed: allowed,
    heartbeatMs: HEARTBEAT_MS,
    minViewSeconds: MIN_VIEW_SECONDS
  };
})();
