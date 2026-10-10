/* ============================================================================
   ESMERINGHOY — CONTENT CATALOG
   ----------------------------------------------------------------------------
   This is the ONLY file that holds your clip data. The admin panel rewrites
   this file for you — you never need to hand-edit it.

   Each entry:
     id       (string)   unique slug, used in the URL: player.html?id=<id>
     title    (string)   display title
     poster   (string|null)  thumbnail URL. null = auto-generated placeholder.
     video    (string|null)  the media file the player loads. Either a full
                             URL (https://.../clip.mp4) or a path relative to
                             the Backblaze base URL below ("clips/01.mp4").
                             mp4 / webm / m3u8 are all supported. null shows a
                             "no video yet" state.
     duration (string)   e.g. "12:34"
     views    (number)   raw view count
     rating   (number)   0-100
     added    (string)   ISO date, drives the "Newest" sort
     tags     (string[]) free-form; shown as the category nav

   NOTE: entries below are neutral PLACEHOLDERS. Replace with content you own
   or are licensed to distribute.
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

window.ESMERINGHOY_CATEGORIES = [
  "Trending",
  "New Releases",
  "Top Rated",
  "Amateur",
  "Studio",
  "HD",
  "4K",
  "POV",
  "Couples",
  "Solo"
];

window.ESMERINGHOY_VIDEOS = [
  { id: "clip-01", title: "Placeholder Clip 01", poster: null, video: null,
    duration: "12:34", views: 128400, rating: 92, added: "2026-10-08",
    tags: ["Trending", "HD", "Studio"] },
  { id: "clip-02", title: "Placeholder Clip 02", poster: null, video: null,
    duration: "08:12", views: 98400, rating: 88, added: "2026-10-07",
    tags: ["Trending", "Amateur", "HD"] },
  { id: "clip-03", title: "Placeholder Clip 03", poster: null, video: null,
    duration: "21:05", views: 312500, rating: 95, added: "2026-09-29",
    tags: ["Top Rated", "Studio", "4K"] },
  { id: "clip-04", title: "Placeholder Clip 04", poster: null, video: null,
    duration: "05:48", views: 42300, rating: 74, added: "2026-10-09",
    tags: ["New Releases", "Solo", "HD"] },
  { id: "clip-05", title: "Placeholder Clip 05", poster: null, video: null,
    duration: "17:22", views: 201300, rating: 90, added: "2026-10-02",
    tags: ["Couples", "Studio", "4K"] },
  { id: "clip-06", title: "Placeholder Clip 06", poster: null, video: null,
    duration: "10:59", views: 76500, rating: 83, added: "2026-10-05",
    tags: ["Amateur", "POV", "HD"] },
  { id: "clip-07", title: "Placeholder Clip 07", poster: null, video: null,
    duration: "14:11", views: 154900, rating: 89, added: "2026-09-25",
    tags: ["Top Rated", "Studio", "HD"] },
  { id: "clip-08", title: "Placeholder Clip 08", poster: null, video: null,
    duration: "06:37", views: 33100, rating: 71, added: "2026-10-10",
    tags: ["New Releases", "Solo", "Amateur"] },
  { id: "clip-09", title: "Placeholder Clip 09", poster: null, video: null,
    duration: "19:44", views: 268700, rating: 94, added: "2026-09-18",
    tags: ["Trending", "Studio", "4K"] },
  { id: "clip-10", title: "Placeholder Clip 10", poster: null, video: null,
    duration: "09:26", views: 88700, rating: 86, added: "2026-10-06",
    tags: ["POV", "Amateur", "HD"] },
  { id: "clip-11", title: "Placeholder Clip 11", poster: null, video: null,
    duration: "23:18", views: 342100, rating: 96, added: "2026-09-12",
    tags: ["Top Rated", "Studio", "4K"] },
  { id: "clip-12", title: "Placeholder Clip 12", poster: null, video: null,
    duration: "11:52", views: 112600, rating: 87, added: "2026-10-01",
    tags: ["Couples", "HD", "Studio"] },
  { id: "clip-13", title: "Placeholder Clip 13", poster: null, video: null,
    duration: "07:39", views: 54900, rating: 78, added: "2026-10-09",
    tags: ["New Releases", "Amateur", "HD"] },
  { id: "clip-14", title: "Placeholder Clip 14", poster: null, video: null,
    duration: "15:07", views: 176200, rating: 91, added: "2026-09-22",
    tags: ["Trending", "Studio", "HD"] },
  { id: "clip-15", title: "Placeholder Clip 15", poster: null, video: null,
    duration: "13:29", views: 94300, rating: 84, added: "2026-10-03",
    tags: ["Solo", "POV", "Amateur"] },
  { id: "clip-16", title: "Placeholder Clip 16", poster: null, video: null,
    duration: "18:53", views: 229800, rating: 93, added: "2026-09-16",
    tags: ["Top Rated", "Couples", "4K"] },
  { id: "clip-17", title: "Placeholder Clip 17", poster: null, video: null,
    duration: "04:21", views: 28700, rating: 69, added: "2026-10-10",
    tags: ["New Releases", "Solo", "HD"] },
  { id: "clip-18", title: "Placeholder Clip 18", poster: null, video: null,
    duration: "16:45", views: 187500, rating: 90, added: "2026-09-27",
    tags: ["Trending", "POV", "Studio"] }
];
