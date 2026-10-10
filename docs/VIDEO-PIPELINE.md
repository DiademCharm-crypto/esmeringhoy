# Encoding and uploading video

How to turn a source file into the adaptive HLS ladder your player already knows
how to switch between, and get it onto Backblaze B2.

Two scripts do the work:

| Script | What it does |
|---|---|
| `tools/hls-encode.sh` | ffmpeg → master playlist, one folder per quality, poster frame |
| `tools/b2-upload.mjs` | uploads a file or a whole folder to B2, with the right Content-Type |

---

## 1. Install ffmpeg

ffmpeg is not bundled — it is a large binary and you only need it when encoding.

- **Windows:** download a build from <https://www.gyan.dev/ffmpeg/builds/> (the
  "essentials" zip is enough), unzip it anywhere, and either add its `bin` folder
  to `PATH` or point the script at it directly:
  ```bash
  FFMPEG=/c/tools/ffmpeg/bin/ffmpeg.exe FFPROBE=/c/tools/ffmpeg/bin/ffprobe.exe \
    bash tools/hls-encode.sh input.mp4
  ```
- **macOS:** `brew install ffmpeg`
- **Debian/Ubuntu:** `sudo apt install ffmpeg`

Check it works: `ffmpeg -version`.

---

## 2. Encode a ladder

```bash
bash tools/hls-encode.sh input.mp4 my-clip-hls
```

```
my-clip-hls/
  master.m3u8            <- point the clip's Video URL at this file
  poster.jpg             <- grabbed automatically at ~10% into the clip
  stream_360p/
    index.m3u8
    init_0.mp4
    seg_0000.m4s …
  stream_480p/ …
  stream_720p/ …
```

### Options

| Flag | Default | Why you would change it |
|---|---|---|
| `--segment-seconds N` | `4` | Shorter = faster quality switching, more requests |
| `--max-short-side N` | `1080` | Cap the ladder (e.g. `720` to keep B2 storage and egress down) |
| `--fps-cap N` | `30` | `60` only if the source really is 60fps |
| `--preset NAME` | `veryfast` | `faster`/`medium` = smaller files, much slower encode |
| `--fallback-mp4` | off | Also write `fallback.mp4` for players without MSE |
| `--poster-time SEC` | 10% in | Pick a better thumbnail frame |
| `--dry-run` | – | Print the ffmpeg command without running it |

### What the script gets right, and why it matters

- **No upscaling.** A 720p source produces a 360/480/720 ladder; there is never a
  fake 1080p rung costing you storage and egress.
- **The ladder is built on the short side.** A vertical 720x1280 clip becomes
  360x640 / 480x854 / 720x1280 — not squashed landscape renditions. ffmpeg's
  rotation metadata is read and applied, so portrait video from a phone encodes
  upright.
- **Keyframes are forced onto the segment boundaries**
  (`-force_key_frames expr:gte(t,n_forced*4)`, `-sc_threshold 0`). Without this,
  segments start mid-GOP and quality switches glitch or stall.
- **One decode, many encodes** (`split` + `filter_complex`), so a 4-rung ladder
  takes roughly the time of one 1080p encode rather than four.
- **fMP4 segments with `EXT-X-MAP`**, VOD playlists, `INDEPENDENT-SEGMENTS` —
  what hls.js and Safari both expect.

> One naming quirk worth knowing: the worker serves the ladder exactly as ffmpeg
> wrote it, so a rung named `720p` is 720 pixels on its **short** side. hls.js
> reports the tall dimension, which is why the player's level list can read
> "1280p" for the 720p rung of a vertical clip.

### Re-encoding for vertical content

Vertical clips are what this ladder shape is for — [player.html](../player.html)
reshapes the frame to the clip's own aspect ratio instead of letterboxing it
into 16:9, using the dimensions it reads from whichever rung is playing. Nothing
extra is needed in the encode: `--max-short-side 720` keeps a phone-shot
vertical clip at a sane size for delivery.

---

## 3. Upload it

Encoding produces dozens of files, so upload the folder:

```bash
B2_KEY_ID=your-key-id \
B2_APPLICATION_KEY=your-key \
B2_BUCKET=your-bucket \
B2_REGION=us-west-004 \
  node tools/b2-upload.mjs ./my-clip-hls --prefix hls/my-clip
```

```
14 file(s), 3.3 MB -> b2://your-bucket/hls/my-clip
  [ 1/14] ok      hls/my-clip/master.m3u8  (application/vnd.apple.mpegurl, 0.0 MB)
  …
uploaded 14, skipped 0, failed 0 — 3.3 MB sent

point the clip's Video URL at: hls/my-clip/master.m3u8
```

| Flag | Notes |
|---|---|
| `--prefix PATH` | Key prefix in the bucket (defaults to the folder name) |
| `--region` | Cluster name from the bucket's S3 endpoint (or `B2_REGION`) |
| `--endpoint` | Full S3 endpoint override |
| `--concurrency N` | Parallel uploads, default 4 |
| `--cache-control` | Stored with every object, e.g. `"public, max-age=31536000"` |
| `--skip-existing` | `HEAD` first; re-run after a failure to send only what is missing |
| `--dry-run` | List what would go up |

`B2_REGION` must be the cluster name (`us-west-004`, `eu-central-003`), which is
shown in the bucket's details next to the S3 endpoint. Getting it wrong makes
every signature invalid — the script refuses to start if the format looks wrong.

**Content-Type is set from the file extension** (`.m3u8` →
`application/vnd.apple.mpegurl`, `.m4s` → `video/iso.segment`, `.mp4` →
`video/mp4`). This is the single most common reason an upload "doesn't play": B2
stores whatever type it is told, and a playlist served as `octet-stream` will not
load. Files are uploaded with the S3 presigned-URL mechanism the admin panel
uses, so nothing needs to be installed on the bucket side beyond the CORS rules
in [HOSTING.md](HOSTING.md).

**Two limits to know:** a single presigned `PUT` tops out at 5 GB (split larger
files into parts, or encode them — a ladder's segments are small by design), and
B2's free tier covers *storage*, not egress. Delivery cost is bandwidth; see
[HOSTING.md](HOSTING.md) for the free-egress setup.

---

## 4. Point a clip at it

In the admin panel, set the clip's **Video URL** to the master playlist:

```
hls/my-clip/master.m3u8
```

The player notices the `.m3u8` and loads hls.js (Safari plays HLS natively). It
picks the rung per network and screen size — there is no quality selector
because there is nothing for the viewer to decide.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ffmpeg not found` | Not on `PATH`; pass `FFMPEG=/path/to/ffmpeg` |
| Playlist loads, video never starts | `EXT-X-MAP`/init segment unreachable, or segments uploaded with a wrong Content-Type |
| Stalls when switching quality | Segments not keyframe-aligned; re-encode rather than hand-editing playlists |
| 403 from your own CDN | The signed URL expired or `SITE_ORIGINS` is missing the site's origin |
| Playback fine locally, 404 in production | The clip path does not match the key prefix you uploaded to |
| Poster is a black frame | Pick a later `--poster-time` |
