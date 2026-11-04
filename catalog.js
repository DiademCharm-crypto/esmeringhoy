/* ============================================================================
   ESMERINGHOY — CONTENT CATALOG
   ----------------------------------------------------------------------------
   This file is the fallback catalog. The admin panel can also publish a live
   catalog to the Worker's D1 database, which visitors load instead; you never
   need to hand-edit either one.

   Each entry:
     id          (string)   unique slug, used in the URL: player.html?id=<id>
     title       (string)   display title
     description (string)   optional intro shown under the player title
     poster   (string|null)  thumbnail. A leading "/" means a file this site
                             serves itself (e.g. "/assets/thumbs/clip.jpg"); a
                             path without one is a bucket key, signed when the
                             bucket is private. null = auto-generated placeholder.
     video    (string|null)  the media file the player loads first. Either a full
                             URL (https://.../clip.mp4) or a path relative to
                             the Backblaze base URL below ("clips/01.mp4").
                             mp4 / webm / m3u8 are all supported. null shows a
                             "no video yet" state.
     clips    (array)    optional. Every part of a title, in order, shown as
                             buttons under the player: [{ label, video }, ...].
                             Same URL/path rules as `video`. When this is set,
                             `video` should be the first part so cards and
                             links play something.
     gallery  (array)    optional. Photos shown under the clips: URLs or bucket
                             paths. Clicking one opens it full screen.
     duration (string)   e.g. "12:34"
     views    (number)   raw view count
     rating   (number)   0-100
     added    (string)   ISO date, drives the "Newest" sort
     tags     (string[]) free-form; shown as the category nav

   NOTE: only publish content you own or are licensed to distribute.
   ========================================================================== */

/* ----------------------------------------------------------------------------
   BACKBLAZE B2
   Put your public B2 file base URL here once, then each clip's `video` can be
   just the path inside the bucket.

   B2 gives you this URL under Bucket Settings -> "Friendly URL" / or use:
     https://<bucketName>.s3.<region>.backblazeb2.com   (S3-compatible)
     https://f<NNN>.backblazeb2.com/file/<bucketName>   (native B2)

   The bucket must be PUBLIC for direct playback, or front it with a CDN.

   signEndpoint is the /token route of the Cloudflare Worker in worker/.
   Set it when the bucket is PRIVATE: the player then exchanges each path for
   a short-lived signed URL instead of hitting the bucket directly. Leave it
   blank and nothing is signed, which is what a public bucket wants.
   -------------------------------------------------------------------------- */
/* Published wiring for esmeringhoy.eu.cc: the same Worker serves the site and
   the media, so a relative endpoint is the whole address. It keeps www and a
   local `wrangler dev` run working with no CORS and no hostname baked in. */
window.ESMERINGHOY_MEDIA = {
  b2BaseUrl: "",
  signEndpoint: "/token"
};

/* The nav follows these, so every entry here should match a tag in use —
   a category nobody has tagged shows an empty page. */
window.ESMERINGHOY_CATEGORIES = [
  "New Releases",
  "Solo",
  "HD"
];

window.ESMERINGHOY_VIDEOS = [
  /* First real clip: 18 parts, plus a photo set from the same shoot. The
     poster is the shot that was picked for the card. Every URL is absolute,
     so nothing here depends on the media base URL being filled in. */
  { id: "si-clouie-na-mahilig-sa-saging",
    title: "Si Clouie na Mahilig sa Saging, Sa Kwarto Inabot ng Umagahin",
    description: "",
    poster: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/005.jpg",
    video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/17.mp4",
    clips: [
      { label: "1", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/17.mp4" },
      { label: "2", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/18.mp4" },
      { label: "3", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/16.mp4" },
      { label: "4", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/15.mp4" },
      { label: "5", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/14.mp4" },
      { label: "6", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/13.mp4" },
      { label: "7", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/12.mp4" },
      { label: "8", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/11.mp4" },
      { label: "9", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/10.mp4" },
      { label: "10", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/09.mp4" },
      { label: "11", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/08.mp4" },
      { label: "12", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/07.mp4" },
      { label: "13", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/06.mp4" },
      { label: "14", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/05.mp4" },
      { label: "15", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/04.mp4" },
      { label: "16", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/03.mp4" },
      { label: "17", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/02.mp4" },
      { label: "18", video: "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/01.mp4" }
    ],
    gallery: [
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/001.jpg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/002.jpg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/003.jpg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/004.jpg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/005.jpg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/01.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/02.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/03.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/04.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/05.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/06.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/07.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/08.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/09.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/10.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/11.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/12.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/13.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/14.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/15.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/16.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/17.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/18.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/19.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/20.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/21.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/22.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/23.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/24.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/25.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/26.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/27.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/28.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/29.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/30.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/31.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/32.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/33.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/34.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/35.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/36.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/37.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/38.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/39.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/40.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/41.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/42.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/43.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/44.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/45.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/46.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/47.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/48.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/49.jpeg",
      "https://f005.backblazeb2.com/file/deymflix01/Esmeringhoy/Clouie+Siote/50.jpeg"
    ],
    duration: "", views: 0, rating: 0, added: "2026-11-03",
    tags: ["New Releases", "Solo", "HD"] }
];
