#!/bin/sh
# End-to-end smoke test inside the real app (debug build).
# Needs the Vite dev server on :1420 (started automatically if absent).
set -eu
cd "$(dirname "$0")/.."
WORK=$(mktemp -d "${TMPDIR:-/tmp}/note4me-e2e.XXXXXX")
VAULT="$WORK/vault"
mkdir -p "$VAULT/Pasta" "$WORK/config"
cat > "$VAULT/Notas.md" <<'MD'
---
custom: manter
# comentário do usuário
---
Texto original.

| a | b |
|---|---|
| 1 | 2 |
MD
printf 'Veja [notas](../Notas.md). Programação segura.\n' > "$VAULT/Pasta/Outra.md"
printf '# Terceira\n' > "$VAULT/Terceira.md"

VITE_PID=""
if ! curl -s -o /dev/null http://127.0.0.1:1420/; then
  deno run -A npm:vite >/dev/null 2>&1 &
  VITE_PID=$!
  sleep 2
fi
cargo build -q -p note4me
NOTE4ME_E2E_OUT="$WORK/report.json" NOTE4ME_E2E_VAULT="$VAULT" NOTE4ME_CONFIG_DIR="$WORK/config" ./target/debug/note4me >/dev/null 2>&1 &
APP=$!
i=0
while [ ! -f "$WORK/report.json" ] && [ $i -lt 120 ]; do sleep 1; i=$((i+1)); done
kill $APP 2>/dev/null || true
[ -n "$VITE_PID" ] && kill $VITE_PID 2>/dev/null || true
if [ ! -f "$WORK/report.json" ]; then echo "E2E: sem relatório (timeout)"; exit 1; fi
cat "$WORK/report.json"
grep -q '"failed": 0' "$WORK/report.json"
