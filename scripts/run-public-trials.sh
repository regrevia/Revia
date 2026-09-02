#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: run-public-trials.sh <trial-kit-directory>' >&2
  exit 64
fi

KIT=$1
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EXECUTABLE=${REVIA_EXECUTABLE:-"$ROOT/bin/revia"}

fail() {
  printf 'public trial execution failed: %s\n' "$1" >&2
  exit 65
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    fail 'shasum or sha256sum is required'
  fi
}

[ -d "$KIT" ] && [ ! -L "$KIT" ] || fail 'trial-kit directory is missing or is a symlink'
[ -f "$KIT/trial-manifest.json" ] || fail 'trial manifest is missing'
command -v jq >/dev/null 2>&1 || fail 'jq is required'
if find "$KIT" -type l -print | grep -q .; then
  fail 'trial kit contains a symlink'
fi

case "$EXECUTABLE" in
  /*) ;;
  *) EXECUTABLE=$(CDPATH= cd -- "$(dirname -- "$EXECUTABLE")" && pwd)/$(basename -- "$EXECUTABLE") ;;
esac
[ -x "$EXECUTABLE" ] || fail "runner is not executable: $EXECUTABLE"

BASE=$(mktemp -d "${TMPDIR:-/tmp}/revia-public-trials.XXXXXX")
trap 'rm -rf "$BASE"' EXIT HUP INT TERM

TRIALS=$(jq -r '.trials | length' "$KIT/trial-manifest.json")
[ "$TRIALS" -gt 0 ] || fail 'trial manifest contains no trials'

trial=0
while [ "$trial" -lt "$TRIALS" ]; do
  id=$(jq -r --argjson index "$trial" '.trials[$index].id' "$KIT/trial-manifest.json")
  run_dir="$BASE/$id"
  mkdir -p "$run_dir"
  cp -R "$KIT"/. "$run_dir"/
  mkdir -p "$run_dir/bin"
  cp "$EXECUTABLE" "$run_dir/bin/revia"
  chmod 755 "$run_dir/bin/revia"

  command_json=$(jq -c --argjson index "$trial" '.trials[$index].command' "$KIT/trial-manifest.json")
  command_shell=$(printf '%s' "$command_json" | jq -r '. | map(@sh) | join(" ")')
  expected_status=$(jq -r --argjson index "$trial" '.trials[$index].expected.exit_status' "$KIT/trial-manifest.json")
  expected_stdout=$(jq -r --argjson index "$trial" '.trials[$index].expected.stdout_sha256' "$KIT/trial-manifest.json")
  expected_stderr=$(jq -r --argjson index "$trial" '.trials[$index].expected.stderr_sha256' "$KIT/trial-manifest.json")
  expected_result=$(jq -r --argjson index "$trial" '.trials[$index].expected.result_sha256' "$KIT/trial-manifest.json")
  result_path=$(jq -r --argjson index "$trial" '.trials[$index].expected.result_path // empty' "$KIT/trial-manifest.json")
  result_fixture=$(jq -r --argjson index "$trial" '.trials[$index].expected.result_fixture // empty' "$KIT/trial-manifest.json")
  for path in "$result_path" "$result_fixture"; do
    case "$path" in
      /*|*..*|*//*)
        [ -z "$path" ] || fail "$id contains an unsafe result path: $path"
        ;;
    esac
  done

  (
    cd "$run_dir"
    set +e
    eval "set -- $command_shell"
    "$@" >stdout 2>stderr
    status=$?
    set -e
    printf '%s\n' "$status" >status
  )

  actual_status=$(cat "$run_dir/status")
  [ "$actual_status" = "$expected_status" ] || fail "$id exit status: expected $expected_status, got $actual_status"
  actual_stdout=$(sha256_file "$run_dir/stdout")
  actual_stderr=$(sha256_file "$run_dir/stderr")
  [ "$actual_stdout" = "$expected_stdout" ] \
    || fail "$id stdout digest mismatch: expected $expected_stdout, got $actual_stdout"
  [ "$actual_stderr" = "$expected_stderr" ] \
    || fail "$id stderr digest mismatch: expected $expected_stderr, got $actual_stderr"

  if [ -n "$result_path" ]; then
    [ -f "$run_dir/$result_path" ] || fail "$id result file is missing: $result_path"
    actual_result=$(sha256_file "$run_dir/$result_path")
    [ "$actual_result" = "$expected_result" ] \
      || fail "$id result digest mismatch: expected $expected_result, got $actual_result"
  else
    [ "$actual_stdout" = "$expected_result" ] \
      || fail "$id canonical result digest mismatch: expected $expected_result, got $actual_stdout"
  fi

  if [ -n "$result_fixture" ]; then
    [ -f "$run_dir/$result_fixture" ] || fail "$id result fixture is missing: $result_fixture"
    [ "$(sha256_file "$run_dir/$result_fixture")" = "$expected_result" ] \
      || fail "$id result fixture digest mismatch"
  fi

  printf '%s\n' "verified $id"
  trial=$((trial + 1))
done

printf '%s\n' "public trials verified: $TRIALS"
