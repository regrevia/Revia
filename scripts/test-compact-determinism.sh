#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MODE=${1:---report}
EXECUTABLE=${REVIA_EXECUTABLE:-"$ROOT/bin/revia"}

case "$EXECUTABLE" in
  /*) ;;
  *)
    EXECUTABLE=$(CDPATH= cd -- "$(dirname -- "$EXECUTABLE")" && pwd)/$(basename -- "$EXECUTABLE")
    ;;
esac

if [ ! -x "$EXECUTABLE" ]; then
  printf '%s\n' "compact determinism probe cannot execute: $EXECUTABLE" >&2
  exit 70
fi

case "$MODE" in
  --report|--require) ;;
  *)
    printf '%s\n' "Usage: $0 [--report|--require]" >&2
    exit 64
    ;;
esac

if command -v shasum >/dev/null 2>&1; then
  SHA256='shasum -a 256'
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256='sha256sum'
else
  printf '%s\n' 'compact determinism probe requires shasum or sha256sum.' >&2
  exit 70
fi

BASE=$(mktemp -d "${TMPDIR:-/tmp}/revia-compact-determinism.XXXXXX")
trap 'rm -rf "$BASE"' EXIT HUP INT TERM

run_case() {
  case_name=$1
  command_name=$2
  work="$BASE/$case_name/$command_name"

  mkdir -p "$work"
  cp "$ROOT/examples/agent-review/main.re" "$work/main.re"
  (
    cd "$work"
    case "$command_name" in
      check)
        "$EXECUTABLE" check main.re >stdout 2>stderr
        ;;
      check-write)
        "$EXECUTABLE" check --write main.re >stdout 2>stderr
        ;;
      manifest)
        "$EXECUTABLE" manifest main.re >manifest.json 2>stderr
        ;;
      view)
        "$EXECUTABLE" view --locale en-US --format html main.re >view.html 2>stderr
        ;;
      build)
        "$EXECUTABLE" build --out build main.re >stdout 2>stderr
        ;;
    esac
    printf '%s\n' "$?" >status
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 $SHA256 >checksums.sha256
  )
}

different=
for command_name in check check-write manifest view build; do
  run_case first "$command_name"
  run_case second "$command_name"

  if cmp -s "$BASE/first/$command_name/checksums.sha256" \
    "$BASE/second/$command_name/checksums.sha256"; then
    printf 'deterministic %s\n' "$command_name"
  else
    printf 'nondeterministic %s\n' "$command_name" >&2
    different=1
  fi
done

if [ -n "$different" ]; then
  printf '%s\n' 'compact determinism: PENDING' >&2
  [ "$MODE" = '--report' ] && exit 0
  exit 1
fi

printf '%s\n' 'compact determinism: VERIFIED'
