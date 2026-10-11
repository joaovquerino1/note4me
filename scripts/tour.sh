#!/bin/sh
# Opens the app in tour mode and captures each screen to $1 (default ./screens).
set -eu
cd "$(dirname "$0")/.."
OUTDIR=${1:-screens}
VAULT=${2:?vault path}
WINID=${3:?window-id helper}
mkdir -p "$OUTDIR"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/note4me-tour.XXXXXX")
cp -R "$VAULT" "$WORK/vault"
cargo build -q -p note4me
NOTE4ME_E2E_MODE=tour NOTE4ME_E2E_OUT="$WORK/report.json" NOTE4ME_E2E_VAULT="$WORK/vault" NOTE4ME_CONFIG_DIR="$WORK/config" ./target/debug/note4me >/dev/null 2>&1 &
APP=$!
last=""
i=0
while [ ! -f "$WORK/report.json" ] && [ $i -lt 600 ]; do
  if [ -f "$WORK/report.json.mark" ]; then
    m=$(cat "$WORK/report.json.mark")
    if [ "$m" != "$last" ]; then
      id=$("$WINID" note4me $APP)
      [ -n "$id" ] && screencapture -x -o -l"$id" "$OUTDIR/$m.png"
      last=$m
    fi
  fi
  sleep 0.2; i=$((i+1))
done
kill $APP 2>/dev/null || true
/bin/ls "$OUTDIR"
