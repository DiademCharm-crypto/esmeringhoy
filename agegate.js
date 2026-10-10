/* ============================================================================
   ESMERINGHOY — 18+ AGE VERIFICATION GATE
   ----------------------------------------------------------------------------
   Blocks the whole site until the visitor confirms they are an adult. The
   confirmation is remembered in localStorage so returning visitors are not
   asked again.

   API:
     EsmeringhoyAgeGate.isUnlocked()  -> boolean
     EsmeringhoyAgeGate.onUnlock(fn)  -> runs fn now if unlocked, otherwise
                                         once the visitor passes the gate
     EsmeringhoyAgeGate.reset()       -> clears the confirmation (for testing)

   Pairs with the `.age-locked` class that index.html / player.html set on
   <html> before first paint, which hides content and prevents scrolling.
   ========================================================================== */

(function () {
  var STORAGE_KEY = "esh_age_ok";
  var EXIT_URL = "https://www.google.com/";
  var callbacks = [];
  var unlocked = false;

  function readStored() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch (e) {
      return false; /* private mode / storage disabled */
    }
  }

  function store() {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch (e) {
      /* non-fatal: the gate simply reappears on the next page */
    }
  }

  function release() {
    unlocked = true;
    document.documentElement.classList.remove("age-locked");
    var overlay = document.getElementById("age-gate");
    if (overlay) overlay.remove();
    callbacks.splice(0).forEach(function (fn) {
      try { fn(); } catch (e) { console.error(e); }
    });
  }

  function buildOverlay() {
    var overlay = document.createElement("div");
    overlay.id = "age-gate";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "age-gate-title");
    overlay.innerHTML =
      '<div class="age-gate-card">' +
        '<div class="age-gate-badge">18+</div>' +
        '<h2 id="age-gate-title">Adults Only</h2>' +
        '<p>This website contains sexually explicit material intended for ' +
        'adults. By entering you confirm that you are at least 18 years old ' +
        '(or the age of majority where you live) and that viewing adult ' +
        'material is legal in your location.</p>' +
        '<div class="age-gate-actions">' +
          '<button type="button" class="btn-primary" id="age-gate-enter">' +
            'I am 18 or older &mdash; Enter' +
          '</button>' +
          '<button type="button" class="btn-ghost" id="age-gate-exit">' +
            'I am under 18 &mdash; Exit' +
          '</button>' +
        '</div>' +
        '<p class="age-gate-fineprint">Your answer is stored on this device only.</p>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.querySelector("#age-gate-enter").addEventListener("click", function () {
      store();
      release();
    });
    overlay.querySelector("#age-gate-exit").addEventListener("click", function () {
      window.location.href = EXIT_URL;
    });
  }

  var api = {
    isUnlocked: function () { return unlocked; },
    onUnlock: function (fn) {
      if (typeof fn !== "function") return;
      if (unlocked) { fn(); } else { callbacks.push(fn); }
    },
    reset: function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    }
  };
  window.EsmeringhoyAgeGate = api;

  function init() {
    if (readStored()) {
      release();
    } else {
      buildOverlay();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
