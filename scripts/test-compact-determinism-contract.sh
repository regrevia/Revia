#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/revia-compact-contract.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

cat >"$TMP/revia" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$REVIA_PROBE_LOG"
EOF
chmod 755 "$TMP/revia"

REVIA_PROBE_LOG="$TMP/invocations" \
REVIA_EXECUTABLE="$TMP/revia" \
sh "$ROOT/scripts/test-compact-determinism.sh" --require

grep -Fxq 'check main.re' "$TMP/invocations"
grep -Fxq 'check --write main.re' "$TMP/invocations"
grep -Fxq 'manifest main.re' "$TMP/invocations"
grep -Fxq 'view --locale en-US --format html main.re' "$TMP/invocations"
grep -Fxq 'build --out build main.re' "$TMP/invocations"

printf '%s\n' 'compact determinism contract checks passed'
