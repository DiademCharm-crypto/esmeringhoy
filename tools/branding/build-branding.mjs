/* ============================================================================
   ESMERINGHOY — BRAND IDENTITY BUILDER
   ----------------------------------------------------------------------------
   One design source, every deliverable. The wordmark is drawn as vector paths,
   not text: no font is loaded or referenced, so the logo renders identically on
   every machine and the letterforms stay editable as strokes.

   Run it from the repo root:

     node tools/branding/build-branding.mjs

   It writes assets/branding/*.svg plus assets/branding/preview.html. The PNG
   exports are produced separately (tools/branding/png-server.mjs) so this file
   has no image dependency at all.

   Design system
     cap height   120 units, stroke weight 22 (a heavy display weight)
     letterforms  geometric skeletons, round terminals, slight forward slant
     palette      crimson #E5093B, hot pink #FF2D75, ink #0B0B0F, white
     signature    the O carries a bite mark, the accent under the wordmark ends
                  in a heart, and the icon's E wears devil horns
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";

const OUT = path.join("assets", "branding");

const C = {
  crimson: "#E5093B",
  pink: "#FF2D75",
  deep: "#7C0420",
  ink: "#0B0B0F",
  white: "#FFFFFF"
};

const CAP = 120;      // cap height in glyph units
const WEIGHT = 22;    // stroke weight
const GAP = 10;       // side bearing between glyph boxes
const SLANT = 9;      // degrees of forward slant

/* --------------------------------------------------------------- letterforms --
   Every glyph lives in a 0..w x 0..120 box, baseline at y=120. Round caps and
   joins finish the ends, so a stem specified from 11 to 109 is exactly 0..120
   tall and 22 wide.

   Each glyph is a function of its own x offset rather than a <g> with a
   translate(), because a stroke gradient in user space is anchored to the
   element that references it: with a per-letter transform every letter would
   restart the same gradient. Baking the offset into the coordinates keeps all
   eleven letters on one continuous sweep of colour. */

const GLYPHS = {
  E: {
    w: 60,
    d: (x) => [
      `M${x + 11} 11V109`,
      `M${x + 11} 11H${x + 49}`,
      `M${x + 11} 59H${x + 42}`,
      `M${x + 11} 109H${x + 49}`
    ]
  },

  S: {
    w: 76,
    d: (x) => [
      `M${x + 64} 29C${x + 64} 13 ${x + 53} 4 ${x + 38} 4` +
      `C${x + 21} 4 ${x + 11} 13 ${x + 11} 28C${x + 11} 42 ${x + 22} 48 ${x + 36} 53` +
      `C${x + 50} 58 ${x + 61} 65 ${x + 61} 81C${x + 61} 98 ${x + 49} 107 ${x + 35} 107` +
      `C${x + 21} 107 ${x + 11} 99 ${x + 10} 85`
    ]
  },

  M: {
    w: 88,
    d: (x) => [`M${x + 11} 109V11L${x + 44} 70L${x + 77} 11V109`]
  },

  R: {
    w: 74,
    d: (x) => [
      `M${x + 11} 11V109`,
      `M${x + 11} 12H${x + 36}C${x + 53} 12 ${x + 62} 20 ${x + 62} 35` +
      `C${x + 62} 50 ${x + 53} 58 ${x + 36} 58H${x + 11}`,
      `M${x + 40} 58L${x + 64} 109`
    ]
  },

  I: {
    w: 22,
    d: (x) => [`M${x + 11} 11V109`]
  },

  N: {
    w: 78,
    d: (x) => [`M${x + 11} 109V11L${x + 67} 109V11`]
  },

  G: {
    w: 84,
    d: (x) => [
      `M${x + 63} 30A35 35 0 1 0 ${x + 45} 95V60H${x + 72}`
    ]
  },

  O: {
    w: 98,
    d: (x) => [`M${x + 49} 11A38 38 0 1 1 ${x + 48.9} 11`]
  },

  Y: {
    w: 76,
    d: (x) => [
      `M${x + 11} 11L${x + 38} 62L${x + 65} 11`,
      `M${x + 38} 62V109`
    ]
  },

  H: {
    w: 76,
    d: (x) => [
      `M${x + 11} 11V109`,
      `M${x + 65} 11V109`,
      `M${x + 11} 59H${x + 65}`
    ]
  }
};

const WORD = "ESMERINGHOY";

/* The O's bite: a scallop taken out of the upper-right of the ring. Expressed
   as a mask so the letterform itself stays a plain circle — edit the circle and
   the bite follows.

   Placement is the whole trick. The notch has to sit on the outer edge and stop
   short of the counter: cut deeper and the ring closes into a C, which is how
   this failed the first time. A 9-unit bite out of a 22-unit ring keeps the O
   continuous and still reads as teeth at header size. */
const O_INDEX = WORD.indexOf("O");
const BITE = { angle: -30, distance: 56, radius: 13 };

function glyphMarkup(ch, x) {
  return GLYPHS[ch].d(x)
    .map((d) => `<path d="${d}"/>`)
    .join("");
}

/* ------------------------------------------------------------- wordmark ----- */

function measureWord() {
  let x = 0;
  const positions = [];
  for (const ch of WORD) {
    positions.push({ ch, x });
    x += GLYPHS[ch].w + GAP;
  }
  return { width: x - GAP, positions };
}

const WORD_METRICS = measureWord();
const SLANT_SHIFT = Math.round(Math.tan((SLANT * Math.PI) / 180) * CAP); // 19

function wordmarkBody() {
  return WORD_METRICS.positions.map((p) => glyphMarkup(p.ch, p.x)).join("");
}

/* The bite sits over the O, so it has to move with it. */
function biteMarkup() {
  const o = WORD_METRICS.positions[O_INDEX];
  const a = (BITE.angle * Math.PI) / 180;
  const cx = o.x + 49 + Math.cos(a) * BITE.distance;
  const cy = 60 + Math.sin(a) * BITE.distance;
  return `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${BITE.radius}" fill="#000"/>`;
}

/* --------------------------------------------------------------- gradients -- */

/* userSpaceOnUse, not objectBoundingBox: a straight bar has a zero-height box,
   and a gradient fitted to it makes the stroke disappear. */
function inkGradient(id, from, to, box) {
  const b = box || { x2: 400, y2: CAP };
  return (
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
    `x1="0" y1="0" x2="${b.x2}" y2="${b.y2}">` +
    `<stop offset="0" stop-color="${from}"/>` +
    `<stop offset=".55" stop-color="${C.crimson}"/>` +
    `<stop offset="1" stop-color="${to}"/>` +
    `</linearGradient>`
  );
}

/* A soft light falling from the top of the tile, so the badge has depth without
   a filter (filters cost real paint time on a logo that appears on every page). */
function glossGradient() {
  return (
    `<linearGradient id="icon-gloss" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="132">` +
    `<stop offset="0" stop-color="#fff" stop-opacity=".22"/>` +
    `<stop offset=".5" stop-color="#fff" stop-opacity="0"/>` +
    `</linearGradient>`
  );
}

/* ---------------------------------------------------------------- accents --- */

/* Swoosh: a tapered ribbon under the wordmark that resolves into a heart. Built
   as one filled leaf so there is no stroke to lose at small sizes. */
function swoosh(x, y, width) {
  const w = width;
  const tip = x + w;
  const k = 0.85;
  /* The heart hangs from the tip: its bottom point is placed on the tip itself,
     so the two shapes meet instead of floating near each other. */
  const heartX = tip - 12 * k;
  const heartY = y - 6 - 21 * k;
  return {
    body:
      /* A wedge, not a hairline: 10 units deep at the left, tapering to the tip,
         rising slightly so it reads as a signature rather than a rule. */
      `<path d="M${x} ${y}C${x + w * 0.34} ${y + 2} ${x + w * 0.72} ${y + 1} ${tip} ${y - 6}` +
      `L${tip} ${y - 3}C${x + w * 0.7} ${y + 5} ${x + w * 0.32} ${y + 7} ${x} ${y + 7}Z"/>` +
      `<path transform="translate(${heartX.toFixed(2)} ${heartY.toFixed(2)}) ` +
      `scale(${k}) rotate(-10 12 10)" d="` +
      `M12 21C5 15 0 11 0 6.5C0 2.9 2.9 0 6.4 0C8.7 0 10.9 1.2 12 3.1` +
      `C13.1 1.2 15.3 0 17.6 0C21.1 0 24 2.9 24 6.5C24 11 19 15 12 21Z"/>`
  };
}

/* ------------------------------------------------------------------- icon --- */

/* 132-unit badge: gradient field, ink E monogram wearing devil horns. Inverted
   from the wordmark on purpose — a bright tile reads far better at 32px in a tab
   strip than dark-on-dark, and it gives the brand a second look that is
   recognisable without the word. */
function iconBody(size, inkId = "ink-icon") {
  const s = size / 132;
  const eScale = 0.82;
  const eW = GLYPHS.E.w * eScale;
  const eH = CAP * eScale;
  const ex = (132 - eW) / 2 - 1;
  const ey = (132 - eH) / 2 + 14;

  /* No horns in the monogram. Three attempts at drawing them attached to the
     E's crossbar all collapsed into one black mass at icon size — the crossbar
     and the horn bases read as a single silhouette. The wordmark's bitten O
     carries the personality; the icon is the mark that has to survive 32px in a
     browser tab, so it stays a clean monogram. */
  return (
    `<g transform="scale(${s})">` +
    `<rect x="0" y="0" width="132" height="132" rx="30" fill="url(#${inkId})"/>` +
    `<rect x="0" y="0" width="132" height="132" rx="30" fill="url(#icon-gloss)"/>` +
    /* the monogram keeps the wordmark's slant, so the icon and the lockup read
       as one brand rather than two drawings */
    `<g transform="translate(6 0) skewX(-6)">` +
    `<g fill="none" stroke="${C.ink}" stroke-width="${WEIGHT * eScale}" ` +
    `stroke-linecap="round" stroke-linejoin="round" ` +
    `transform="translate(${ex.toFixed(2)} ${ey.toFixed(2)}) scale(${eScale})">` +
    GLYPHS.E.d(0).map((d) => `<path d="${d}"/>`).join("") +
    `</g></g>` +
    `</g>`
  );
}

/* -------------------------------------------------------------- assembling -- */

function horizontalLogo({ inkFrom, inkTo, bg, wordOnly = false }) {
  const iconSize = 132;
  const gap = 30;
  const wordX = wordOnly ? 0 : iconSize + gap;
  const swooshW = Math.round(WORD_METRICS.width * 0.42);

  /* Tall enough for the accent to breathe under the baseline, so the signature
     never collides with the letters it is signing. */
  const height = 200;
  const width = wordX + WORD_METRICS.width + SLANT_SHIFT + 24;

  const bgRect = bg
    ? `<rect x="0" y="0" width="${width}" height="${height}" fill="${bg}"/>`
    : "";

  const icon = wordOnly
    ? ""
    : `<g transform="translate(6 ${(height - iconSize) / 2})">${iconBody(iconSize)}</g>`;

  return {
    width,
    height,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `width="${width}" height="${height}" role="img" ` +
      `aria-label="ESMERINGHOY">` +
      `<title>ESMERINGHOY</title>` +
      `<defs>${inkGradient("ink-word", inkFrom, inkTo, {
        x2: Math.round(WORD_METRICS.width * 0.42),
        y2: CAP
      })}${inkGradient("ink-icon", inkFrom, inkTo, { x2: 66, y2: 132 })}` +
      glossGradient() +
      `</defs>` +
      bgRect +
      icon +
      `<g transform="translate(${wordX + SLANT_SHIFT} ${height / 2 - CAP / 2 - 10})">` +
      `<g transform="skewX(-${SLANT})">` +
      `<mask id="bite" maskUnits="userSpaceOnUse" x="-40" y="-40" ` +
      `width="${WORD_METRICS.width + 80}" height="${CAP + 80}">` +
      `<rect x="-40" y="-40" width="${WORD_METRICS.width + 80}" height="${CAP + 80}" fill="#fff"/>` +
      biteMarkup() +
      `</mask>` +
      `<g mask="url(#bite)" fill="none" stroke="url(#ink-word)" stroke-width="${WEIGHT}" ` +
      `stroke-linecap="round" stroke-linejoin="round">${wordmarkBody()}</g>` +
      `<g fill="url(#ink-word)">${swoosh(SLANT_SHIFT - 6, CAP + 34, swooshW).body}</g>` +
      `</g></g></svg>`
  };
}

/* The icon file is the tile and nothing else: no transparent margin around it.
   An app icon that arrives padded gets padded again by every launcher that
   draws it, and the PNG exports should fill their 512/1024 canvas edge to edge. */
function iconFile({ bg }) {
  const size = 132;
  const bgRect = bg
    ? `<rect x="0" y="0" width="${size}" height="${size}" fill="${bg}"/>`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size}" height="${size}" role="img" aria-label="ESMERINGHOY icon">` +
    `<title>ESMERINGHOY</title>` +
    `<defs>${inkGradient("ink-icon", C.pink, C.deep, { x2: 66, y2: 132 })}` +
    `${glossGradient()}</defs>` +
    bgRect +
    iconBody(132) +
    `</svg>`
  );
}

/* A 32-unit favicon: fewer moving parts, thicker rim, no fine detail, so it
   holds up in a browser tab. */
function faviconFile() {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">` +
    `<defs>${inkGradient("ink-fav", C.pink, C.crimson, { x2: 18, y2: 32 })}</defs>` +
    `<rect x="0" y="0" width="32" height="32" rx="7" fill="${C.ink}"/>` +
    `<rect x="1.5" y="1.5" width="29" height="29" rx="6" fill="none" ` +
    `stroke="url(#ink-fav)" stroke-width="2.5"/>` +
    `<g fill="none" stroke="url(#ink-fav)" stroke-width="4.4" stroke-linecap="round" ` +
    `stroke-linejoin="round" transform="translate(9.9 6.7) scale(.212)">` +
    GLYPHS.E.d(0).map((d) => `<path d="${d}"/>`).join("") +
    `</g></svg>`
  );
}

/* ------------------------------------------------------------------ output -- */

const files = {};

files["esmeringhoy-logo-horizontal.svg"] = horizontalLogo({
  inkFrom: C.pink, inkTo: C.crimson, bg: null
}).svg;

files["esmeringhoy-logo-horizontal-on-dark.svg"] = horizontalLogo({
  inkFrom: C.pink, inkTo: C.crimson, bg: C.ink
}).svg;

files["esmeringhoy-logo-horizontal-on-light.svg"] = horizontalLogo({
  inkFrom: C.crimson, inkTo: C.deep, bg: C.white
}).svg;

files["esmeringhoy-wordmark.svg"] = horizontalLogo({
  inkFrom: C.pink, inkTo: C.crimson, bg: null, wordOnly: true
}).svg;

files["esmeringhoy-icon.svg"] = iconFile({ bg: null });
files["esmeringhoy-icon-on-dark.svg"] = iconFile({ bg: C.ink });
files["esmeringhoy-icon-on-light.svg"] = iconFile({ bg: C.white });
files["favicon.svg"] = faviconFile();

fs.mkdirSync(OUT, { recursive: true });
for (const [name, svg] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), svg.endsWith("\n") ? svg : svg + "\n");
}

/* ---------------------------------------------------------------- preview --- */

const preview = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ESMERINGHOY — brand assets</title>
<style>
  :root { --ink:#0B0B0F; --crimson:#E5093B; --pink:#FF2D75; --line:rgba(255,255,255,.14); }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--ink); color:#fff;
         font:15px/1.6 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif; }
  header { padding:44px 32px 10px; max-width:1180px; margin:0 auto; }
  h1 { margin:0 0 6px; font-size:26px; letter-spacing:.02em; }
  p.lede { margin:0; color:#a9a9b4; max-width:64ch; }
  main { max-width:1180px; margin:0 auto; padding:26px 32px 80px; }
  h2 { font-size:13px; letter-spacing:.16em; text-transform:uppercase;
       color:#8d8d99; margin:38px 0 14px; font-weight:600; }
  .grid { display:grid; gap:18px; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); }
  .card { border:1px solid var(--line); border-radius:14px; overflow:hidden;
          background:#111118; }
  .card .stage { display:flex; align-items:center; justify-content:center;
                 padding:26px 22px; min-height:150px; }
  .stage.dark { background:radial-gradient(120% 120% at 50% 0%,#191922 0%,#0d0d12 70%); }
  .stage.light { background:#fff; }
  .stage img { max-width:100%; height:auto; }
  .meta { border-top:1px solid var(--line); padding:10px 14px;
          display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
  .meta code { font-size:12px; color:#c8c8d2; }
  .meta span { font-size:11px; color:#6f6f7c; white-space:nowrap; }
  .sizes { display:flex; align-items:flex-end; gap:18px; flex-wrap:wrap; }
  .sizes figure { margin:0; text-align:center; }
  .sizes figcaption { font-size:10px; color:#6f6f7c; margin-top:8px; letter-spacing:.08em; }
  .note { border-left:2px solid var(--crimson); padding:2px 0 2px 14px; color:#a9a9b4;
          max-width:70ch; margin:18px 0 0; }
  .pairs { display:grid; gap:18px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); }
</style>
</head>
<body>
<header>
  <h1>ESMERINGHOY — brand assets</h1>
  <p class="lede">Custom vector wordmark, lockup and icon. No font files, no raster
  images: every shape is an editable path, so the logo scales from a browser tab
  to a billboard without a second source file.</p>
</header>
<main>

  <h2>Primary lockup</h2>
  <div class="grid">
    <div class="card">
      <div class="stage dark"><img src="esmeringhoy-logo-horizontal.svg" alt="ESMERINGHOY horizontal logo" width="620"></div>
      <div class="meta"><code>esmeringhoy-logo-horizontal.svg</code><span>transparent · dark</span></div>
    </div>
    <div class="card">
      <div class="stage light"><img src="esmeringhoy-logo-horizontal-on-light.svg" alt="ESMERINGHOY logo for light backgrounds" width="620"></div>
      <div class="meta"><code>esmeringhoy-logo-horizontal-on-light.svg</code><span>white · dark ink</span></div>
    </div>
  </div>

  <h2>Background-ready versions</h2>
  <div class="pairs">
    <div class="card">
      <div class="stage dark"><img src="esmeringhoy-logo-horizontal-on-dark.svg" alt="Logo on ink background" width="560"></div>
      <div class="meta"><code>esmeringhoy-logo-horizontal-on-dark.svg</code><span>social, OG image</span></div>
    </div>
    <div class="card">
      <div class="stage dark"><img src="esmeringhoy-wordmark.svg" alt="Wordmark only" width="560"></div>
      <div class="meta"><code>esmeringhoy-wordmark.svg</code><span>no icon</span></div>
    </div>
  </div>

  <h2>Icon</h2>
  <div class="grid">
    <div class="card">
      <div class="stage dark">
        <div class="sizes">
          <figure><img src="esmeringhoy-icon.svg" alt="Icon" width="132"><figcaption>132</figcaption></figure>
          <figure><img src="esmeringhoy-icon.svg" alt="" width="64"><figcaption>64</figcaption></figure>
          <figure><img src="esmeringhoy-icon.svg" alt="" width="40"><figcaption>40</figcaption></figure>
          <figure><img src="favicon.svg" alt="Favicon" width="32"><figcaption>favicon 32</figcaption></figure>
        </div>
      </div>
      <div class="meta"><code>esmeringhoy-icon.svg</code><span>transparent · app icon</span></div>
    </div>
    <div class="card">
      <div class="stage light">
        <div class="sizes">
          <figure><img src="esmeringhoy-icon-on-light.svg" alt="Icon on white" width="132"><figcaption>132</figcaption></figure>
          <figure><img src="esmeringhoy-icon-on-light.svg" alt="" width="56"><figcaption>56</figcaption></figure>
          <figure><img src="favicon.svg" alt="" width="32"><figcaption>favicon</figcaption></figure>
        </div>
      </div>
      <div class="meta"><code>esmeringhoy-icon-on-light.svg</code><span>white field</span></div>
    </div>
  </div>

  <h2>Lettering detail</h2>
  <div class="card">
    <div class="stage dark"><img src="esmeringhoy-wordmark.svg" alt="Wordmark detail" width="820"></div>
    <div class="meta"><code>the O carries a bite; the accent resolves into a heart</code><span>cap 120 · stroke 22</span></div>
  </div>
  <p class="note">The wordmark is drawn from eleven hand-built glyph skeletons — no font
  is embedded or referenced. Bars, bowls and diagonals share one 22-unit weight,
  and the whole word is slanted 9° for momentum. Edit a glyph in
  <code>tools/branding/build-branding.mjs</code> and every variant follows.</p>

  <h2>PNG exports</h2>
  <div class="grid" id="pngs"></div>
  <p class="note">Rasterised from these same vectors at 512 and 1024 with a
  transparent background.</p>
</main>
<script>
  /* List the PNG exports that exist next to this page, without hard-coding a
     name that a rename would silently break. */
  var pngs = [
    ["esmeringhoy-logo-horizontal-1024.png", "lockup · 1024"],
    ["esmeringhoy-logo-horizontal-512.png", "lockup · 512"],
    ["esmeringhoy-icon-1024.png", "icon · 1024"],
    ["esmeringhoy-icon-512.png", "icon · 512"]
  ];
  var host = document.getElementById("pngs");
  pngs.forEach(function (p) {
    var card = document.createElement("div");
    card.className = "card";
    card.innerHTML = '<div class="stage dark"><img src="' + p[0] + '" alt="' + p[1] +
      '" style="max-height:150px"></div><div class="meta"><code>' + p[0] +
      "</code><span>" + p[1] + "</span></div>";
    var img = card.querySelector("img");
    img.onerror = function () { card.remove(); };
    host.appendChild(card);
  });
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(OUT, "preview.html"), preview);

console.log("wrote " + Object.keys(files).length + " svg files + preview.html to " + OUT);
console.log("wordmark: " + WORD_METRICS.width + " x " + CAP + " units");
for (const name of Object.keys(files)) {
  console.log("  " + name + "  (" + files[name].length + " bytes)");
}
