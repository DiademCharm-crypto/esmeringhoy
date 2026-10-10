/* ============================================================================
   ESMERINGHOY — SYNTHETIC HLS FIXTURE (for tests and CI only)
   ----------------------------------------------------------------------------
   Writes the object layout the Worker test suite expects into a directory, so
   the suite can run anywhere without a real encode:

     master.m3u8                      two variants
     stream_360p/index.m3u8           EXT-X-MAP + two segments
     stream_360p/init_0.mp4
     stream_360p/seg_0000.m4s
     stream_360p/seg_0001.m4s
     stream_480p/index.m3u8           same shape, second rendition
     stream_480p/init_1.mp4
     stream_480p/seg_0000.m4s
     poster.jpg

   What this is and is not: the suite checks the *routing and rewriting* of an
   HLS ladder — which URLs get signed, which folder a rewritten URI resolves
   into, that a segment comes back as bytes, that a range request is a 206, that
   playlists stay out of the cache. All of that is decided by playlist structure
   and object keys, never by video content, so the segments are arbitrary bytes
   and no ffmpeg is involved. This fixture says nothing about whether a real
   encode plays; tools/hls-encode.sh and a browser do that.

   Usage:
     node tools/test-fixture.mjs [outputDir]
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUT = process.argv[2] || path.join(process.env.TEMP || "/tmp", "esh-hls-fixture");

function bytes(size) {
  /* Random rather than zero-filled: a range request against a run of zeroes
     cannot tell a correct byte slice from a padded response. */
  return crypto.randomBytes(size);
}

function write(relative, contents) {
  const file = path.join(OUT, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return relative;
}

function variant(folder, sequence, initName) {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:4",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    '#EXT-X-MAP:URI="' + initName + '"',
    "#EXTINF:4.000000,",
    "seg_0000.m4s",
    "#EXTINF:4.000000,",
    "seg_0001.m4s",
    "#EXT-X-ENDLIST",
    ""
  ].join("\n");
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const written = [];

written.push(write("master.m3u8", [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=760000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2"',
  "stream_360p/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=1400000,AVERAGE-BANDWIDTH=1320000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"',
  "stream_480p/index.m3u8",
  ""
].join("\n")));

written.push(write("stream_360p/index.m3u8", variant("stream_360p", 0, "init_0.mp4")));
written.push(write("stream_360p/init_0.mp4", bytes(900)));
written.push(write("stream_360p/seg_0000.m4s", bytes(2048)));
written.push(write("stream_360p/seg_0001.m4s", bytes(2048)));

written.push(write("stream_480p/index.m3u8", variant("stream_480p", 1, "init_1.mp4")));
written.push(write("stream_480p/init_1.mp4", bytes(900)));
written.push(write("stream_480p/seg_0000.m4s", bytes(4096)));
written.push(write("stream_480p/seg_0001.m4s", bytes(4096)));

/* A real JPEG header so anything that sniffs the file recognises it. */
written.push(write("poster.jpg", Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  bytes(4096),
  Buffer.from([0xff, 0xd9])
])));

console.log("synthetic HLS fixture in " + OUT);
for (const name of written) {
  const size = fs.statSync(path.join(OUT, name)).size;
  console.log("  " + String(size).padStart(6) + "  " + name);
}
