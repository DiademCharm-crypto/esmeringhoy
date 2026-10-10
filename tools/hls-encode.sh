#!/usr/bin/env bash
# =============================================================================
# ESMERINGHOY — HLS quality-ladder encoder
# -----------------------------------------------------------------------------
# Turns one source video into an adaptive HLS ladder (master playlist + one
# folder per rendition + a poster), ready to upload to Backblaze B2.
#
#   tools/hls-encode.sh INPUT.mp4 [OUTPUT_DIR] [options]
#
# Options:
#   --segment-seconds N   Target segment length (default 4)
#   --max-short-side N    Cap the ladder's short side: 1080, 720, 480... (default 1080)
#   --fps-cap N           Cap the frame rate (default 30)
#   --preset NAME         libx264 preset: veryfast / faster / medium (default veryfast)
#   --fallback-mp4        Also write a progressive MP4 for players without MSE
#   --poster-time SEC     Timestamp for the poster frame (default: 10% into the clip)
#   --dry-run             Print the ffmpeg command without running it
#
# Environment:
#   FFMPEG / FFPROBE       Override the binaries (e.g. FFMPEG=/c/tools/ffmpeg.exe)
#
# Why a ladder and not a single file: the player picks a rendition per network
# and screen size, so a phone on 4G never downloads the 1080p bits it cannot
# show. That is the "quality switching" the player already supports when a clip
# URL points at an .m3u8.
#
# Portrait clips are handled on purpose: the ladder is built on the *short side*
# of the video, and rotation metadata from phones is read and applied, so a
# vertical clip is not silently encoded as a squashed landscape one.
# =============================================================================

set -euo pipefail

die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
info() { printf '\033[36m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- arguments --

if [ $# -lt 1 ]; then
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
case "${1:-}" in
  -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

INPUT="$1"; shift
[ -f "$INPUT" ] || die "input file not found: $INPUT"

BASENAME="$(basename "$INPUT")"
BASENAME="${BASENAME%.*}"
OUTPUT="${1:-${BASENAME}-hls}"
case "${1:-}" in
  --*) OUTPUT="${BASENAME}-hls" ;;
  *) shift ;;
esac

SEGMENT_SECONDS=4
MAX_SHORT_SIDE=1080
FPS_CAP=30
PRESET="veryfast"
FALLBACK_MP4=0
POSTER_TIME=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --segment-seconds) SEGMENT_SECONDS="$2"; shift 2 ;;
    --max-short-side)  MAX_SHORT_SIDE="$2"; shift 2 ;;
    --fps-cap)         FPS_CAP="$2"; shift 2 ;;
    --preset)          PRESET="$2"; shift 2 ;;
    --fallback-mp4)    FALLBACK_MP4=1; shift ;;
    --poster-time)     POSTER_TIME="$2"; shift 2 ;;
    --dry-run)         DRY_RUN=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

FFMPEG="${FFMPEG:-ffmpeg}"
FFPROBE="${FFPROBE:-ffprobe}"
command -v "$FFMPEG" >/dev/null 2>&1 || die "ffmpeg not found. Install it, or set FFMPEG=/path/to/ffmpeg (Windows builds: https://www.gyan.dev/ffmpeg/builds/)"
command -v "$FFPROBE" >/dev/null 2>&1 || die "ffprobe not found. Install it, or set FFPROBE=/path/to/ffprobe"

# ------------------------------------------------------------------- probe ---

probe() { "$FFPROBE" -v error -select_streams v:0 -show_entries "$1" -of default=nw=1:nk=1 "$INPUT" | head -1; }

WIDTH="$(probe stream=width)"
HEIGHT="$(probe stream=height)"
[ -n "$WIDTH" ] && [ -n "$HEIGHT" ] || die "could not read video dimensions from $INPUT"

# Phones store vertical video as landscape pixels plus a rotation flag. ffmpeg
# rotates on decode (autorotate is on by default), so the *displayed* shape is
# the stored shape with width and height swapped when rotated by 90/270.
ROTATION="$("$FFPROBE" -v error -select_streams v:0 \
  -show_entries stream_side_data=rotation -of default=nw=1:nk=1 "$INPUT" | head -1)"
ROTATION="${ROTATION:-0}"
case "${ROTATION#-}" in
  90|270) DISPLAY_W="$HEIGHT"; DISPLAY_H="$WIDTH" ;;
  *)      DISPLAY_W="$WIDTH";  DISPLAY_H="$HEIGHT" ;;
esac

FPS_RAW="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nw=1:nk=1 "$INPUT" | head -1)"
case "$FPS_RAW" in
  */*) FPS=$(( ${FPS_RAW%%/*} / ${FPS_RAW##*/} )) ;;
  *)   FPS="${FPS_RAW%%.*}" ;;
esac
[ -n "$FPS" ] && [ "$FPS" -gt 0 ] 2>/dev/null || FPS=30

HAS_AUDIO=$("$FFPROBE" -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 "$INPUT" | head -1)
DURATION="$("$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 "$INPUT" | head -1)"

if [ "$DISPLAY_H" -ge "$DISPLAY_W" ]; then ORIENTATION="portrait"; else ORIENTATION="landscape"; fi
SHORT_SIDE=$(( DISPLAY_W < DISPLAY_H ? DISPLAY_W : DISPLAY_H ))

info "source: ${WIDTH}x${HEIGHT} stored, ${DISPLAY_W}x${DISPLAY_H} displayed (${ORIENTATION}), ${FPS} fps, rotation ${ROTATION}"
[ -n "$HAS_AUDIO" ] && info "audio: yes" || info "audio: none"
[ -n "$DURATION" ] && info "duration: $(printf '%.1f' "$DURATION")s"

# ------------------------------------------------------------------- ladder --

# Target short-side heights. Only renditions that do not upscale are kept, and
# the smallest one is always present so every source gets a valid ladder.
LADDER_HEIGHTS=(360 480 720 1080)
RENDITIONS=()
for h in "${LADDER_HEIGHTS[@]}"; do
  if [ "$h" -le "$SHORT_SIDE" ] && [ "$h" -le "$MAX_SHORT_SIDE" ]; then RENDITIONS+=("$h"); fi
done
if [ "${#RENDITIONS[@]}" -eq 0 ]; then RENDITIONS=("$SHORT_SIDE"); fi

# Encode fps: never go above the cap, and round down to a whole number.
if [ "$FPS" -gt "$FPS_CAP" ]; then ENCODE_FPS="$FPS_CAP"; else ENCODE_FPS="$FPS"; fi
GOP=$(( ENCODE_FPS * SEGMENT_SECONDS ))

# Per-rendition CRF: smaller renditions can carry a little more compression
# without it being visible, which keeps the low end cheap on B2 egress.
crf_for() {
  case "$1" in
    1080) echo 21 ;;
    720)  echo 22 ;;
    480)  echo 23 ;;
    *)    echo 24 ;;
  esac
}
ab_for() {
  case "$1" in
    1080) echo 160k ;;
    720)  echo 128k ;;
    480)  echo 128k ;;
    *)    echo 96k ;;
  esac
}

# ------------------------------------------------------------------- output --

mkdir -p "$OUTPUT"
VARIANT_NAMES=()
FILTER_PARTS=()
MAP_ARGS=()
VAR_STREAM_MAP=()

for i in "${!RENDITIONS[@]}"; do
  short="${RENDITIONS[$i]}"
  name="${short}p"
  VARIANT_NAMES+=("$name")
  mkdir -p "$OUTPUT/stream_$name"

  # Scale so the SHORT side hits the target and the long side keeps its aspect
  # ratio. -2 keeps the derived dimension even, which H.264 requires.
  if [ "$ORIENTATION" = "portrait" ]; then
    FILTER_PARTS+=("[v${i}]fps=${ENCODE_FPS},scale=${short}:-2[v${i}out]")
  else
    FILTER_PARTS+=("[v${i}]fps=${ENCODE_FPS},scale=-2:${short}[v${i}out]")
  fi

  MAP_ARGS+=(-map "[v${i}out]")
  if [ -n "$HAS_AUDIO" ]; then
    MAP_ARGS+=(-map 0:a:0 "-c:a:${i}" aac "-b:a:${i}" "$(ab_for "$short")" "-ac:a:${i}" 2)
    VAR_STREAM_MAP+=("v:${i},a:${i},name:${name}")
  else
    VAR_STREAM_MAP+=("v:${i},name:${name}")
  fi

  MAP_ARGS+=("-c:v:${i}" libx264 "-preset:v:${i}" "$PRESET" "-crf:v:${i}" "$(crf_for "$short")" \
    "-profile:v:${i}" high "-level:v:${i}" 4.0 \
    "-g:v:${i}" "$GOP" "-keyint_min:v:${i}" "$GOP" "-sc_threshold:v:${i}" 0 \
    "-force_key_frames:v:${i}" "expr:gte(t,n_forced*${SEGMENT_SECONDS})")
done

SPLIT_INPUTS=""
for i in "${!RENDITIONS[@]}"; do SPLIT_INPUTS+="[v${i}]"; done

# Split once and encode every rendition from a single decode pass.
FILTER_COMPLEX="[0:v:0]split=${#RENDITIONS[@]}${SPLIT_INPUTS};$(IFS=';'; echo "${FILTER_PARTS[*]}")"

CMD=("$FFMPEG" -hide_banner -y -i "$INPUT"
  -filter_complex "$FILTER_COMPLEX"
  "${MAP_ARGS[@]}"
  -f hls
  -hls_time "$SEGMENT_SECONDS"
  -hls_playlist_type vod
  -hls_flags independent_segments
  -hls_segment_type fmp4
  -hls_fmp4_init_filename "init.mp4"
  -hls_segment_filename "$OUTPUT/stream_%v/seg_%04d.m4s"
  -var_stream_map "$(IFS=' '; echo "${VAR_STREAM_MAP[*]}")"
  -master_pl_name master.m3u8
  "$OUTPUT/stream_%v/index.m3u8")

info "ladder: $(IFS=', '; echo "${VARIANT_NAMES[*]}") (fps ${ENCODE_FPS}, ${SEGMENT_SECONDS}s segments, GOP ${GOP})"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n%s\n' "${CMD[@]}"
  exit 0
fi

info "encoding…"
"${CMD[@]}"

[ -f "$OUTPUT/master.m3u8" ] || die "ffmpeg finished but $OUTPUT/master.m3u8 is missing"
for name in "${VARIANT_NAMES[@]}"; do
  [ -f "$OUTPUT/stream_$name/index.m3u8" ] || die "missing variant playlist for $name"
done

# ------------------------------------------------------------------- poster --

# A poster saved next to the ladder keeps the site's thumbnails looking like the
# video itself instead of a generated gradient.
POSTER="$OUTPUT/poster.jpg"
if [ -z "$POSTER_TIME" ]; then
  if [ -n "$DURATION" ]; then
    POSTER_TIME="$(awk -v d="$DURATION" 'BEGIN { t = d * 0.1; if (t > 5) t = 5; if (t < 0.5) t = 0.5; printf "%.2f", t }')"
  else
    POSTER_TIME=1
  fi
fi
"$FFMPEG" -hide_banner -loglevel error -y -ss "$POSTER_TIME" -i "$INPUT" \
  -frames:v 1 -vf "scale='min(1280,iw)':-2" -q:v 3 "$POSTER" || info "poster frame failed (continuing)"

# ------------------------------------------------------------- fallback mp4 --

if [ "$FALLBACK_MP4" -eq 1 ]; then
  BIGGEST="${RENDITIONS[-1]}"
  MP4="$OUTPUT/fallback.mp4"
  info "writing progressive fallback ($MP4) for browsers without MSE…"
  if [ "$ORIENTATION" = "portrait" ]; then SCALE="scale=${BIGGEST}:-2"; else SCALE="scale=-2:${BIGGEST}"; fi
  "$FFMPEG" -hide_banner -loglevel error -y -i "$INPUT" \
    -vf "$SCALE,fps=${ENCODE_FPS}" -c:v libx264 -preset "$PRESET" -crf "$(crf_for "$BIGGEST")" \
    -profile:v high -level 4.0 -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 \
    -pix_fmt yuv420p -movflags +faststart \
    ${HAS_AUDIO:+-c:a aac -b:a 128k -ac 2} \
    "$MP4" || info "fallback mp4 failed (continuing)"
fi

# ------------------------------------------------------------------ summary --

SEGMENT_COUNT=0
for name in "${VARIANT_NAMES[@]}"; do
  n=$(grep -c '\.m4s$' "$OUTPUT/stream_$name/index.m3u8" || true)
  SEGMENT_COUNT=$(( SEGMENT_COUNT + n ))
  printf '  %-8s %s segments\n' "$name" "$n"
done

SIZE=$(du -sh "$OUTPUT" 2>/dev/null | cut -f1 | tr -d ' \r')
info "done: $OUTPUT ($SEGMENT_COUNT segments across ${#RENDITIONS[@]} renditions, ${SIZE:-?} on disk)"
if [ -f "$POSTER" ]; then info "poster: $POSTER"; fi
echo
info "next: upload it and point a clip at the master playlist"
echo "  node tools/b2-upload.mjs \"$OUTPUT\" --prefix \"hls/$BASENAME\""
echo "  then set the clip's Video URL to: hls/$BASENAME/master.m3u8"
