#!/usr/bin/env bash
# Mixes the narration clips and the music bed onto the explainer.
# The picture is copied bit for bit (-c:v copy); only an audio track is added.
#
#   node music.js && node tts.js && bash mix.sh
#     -> adaptive-effort-explainer-narrated.mp4
#   bash mix.sh short
#     -> adaptive-effort-short.mp4 (opens on the hook, no lead-in)
set -euo pipefail
cd "$(dirname "$0")"

VIDEO=adaptive-effort-explainer.mp4
OUT=adaptive-effort-explainer-narrated.mp4
STARTS=(0 5 12 23 31 44 52)   # scene starts, seconds
LENGTHS=(5 7 11 8 13 8 8)     # scene lengths, seconds
FIRST=audio/line-1.wav        # the opening line
FIRST_LEAD=0.2
if [ "${1:-}" = short ]; then
  VIDEO=adaptive-effort-short-silent.mp4
  OUT=adaptive-effort-short.mp4
  STARTS=(0 6 13 24 32 45 53)
  LENGTHS=(6 7 11 8 13 8 7)
  FIRST=audio/hook.wav
  FIRST_LEAD=0
fi
LEAD=0.2                      # speech starts this long after its scene does
TAIL=0.4                      # and ends at least this long before the next

# Each clip: trim silence, then normalize to -16 LUFS.
for i in 1 2 3 4 5 6 7; do
  src="audio/line-$i.wav"
  [ "$i" = 1 ] && src="$FIRST"
  ffmpeg -v error -y -i "$src" -af \
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,loudnorm=I=-16:TP=-2:LRA=7,aresample=48000" \
    "audio/trim-$i.wav"
done

# Place each clip at its scene, easing it up to 1.10x only if it would overrun.
inputs=(-i "$VIDEO")
chains=""
labels=""
for i in 0 1 2 3 4 5 6; do
  clip="audio/trim-$((i + 1)).wav"
  inputs+=(-i "$clip")
  len=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$clip")
  lead=$LEAD
  [ "$i" = 0 ] && lead=$FIRST_LEAD
  tempo=$(awk -v l="$len" -v s="${LENGTHS[$i]}" -v a="$lead" -v b="$TAIL" 'BEGIN { t = l / (s - a - b); if (t < 1) t = 1; if (t > 1.10) t = 1.10; printf "%.3f", t }')
  delay=$(awk -v s="${STARTS[$i]}" -v a="$lead" 'BEGIN { printf "%d", (s + a) * 1000 }')
  echo "line $((i + 1)): ${len}s, tempo ${tempo}x, at ${delay}ms"
  chains+="[$((i + 1)):a]atempo=${tempo},adelay=${delay}:all=1[v$i];"
  labels+="[v$i]"
done
inputs+=(-i audio/music-bed.wav)

filter="${chains}${labels}amix=inputs=7:normalize=0:duration=longest,apad=whole_dur=60,atrim=0:60,aformat=channel_layouts=stereo[voice];"
filter+="[voice]asplit=2[vo][sc];"
# Music sits about 20 dB under the voice and ducks a further few dB while it speaks.
filter+="[8:a]aresample=48000,atrim=0:60,volume=-13.3dB,afade=t=in:d=1,afade=t=out:st=58:d=2[m];"
filter+="[m][sc]sidechaincompress=threshold=0.03:ratio=4:attack=30:release=600[md];"
filter+="[vo][md]amix=inputs=2:normalize=0,alimiter=limit=0.89[mix]"

ffmpeg -v error -y "${inputs[@]}" -filter_complex "$filter" \
  -map 0:v -map "[mix]" -c:v copy -c:a aac -b:a 192k -ar 48000 -t 60 -movflags +faststart "$OUT.tmp.mp4"

# Bring the whole mix to -16 LUFS with one static gain, so nothing pumps.
measured=$(ffmpeg -hide_banner -i "$OUT.tmp.mp4" -map 0:a -af ebur128=framelog=quiet -f null - 2>&1 | awk '/I:/ { v = $2 } END { print v }')
gain=$(awk -v m="$measured" 'BEGIN { printf "%.2f", -16 - m }')
echo "mix measured ${measured} LUFS, applying ${gain} dB"
ffmpeg -v error -y -i "$OUT.tmp.mp4" -map 0:v -map 0:a -c:v copy -af "volume=${gain}dB,alimiter=limit=0.89" \
  -c:a aac -b:a 192k -ar 48000 -movflags +faststart "$OUT"
rm -f "$OUT.tmp.mp4"
echo "wrote $OUT"
