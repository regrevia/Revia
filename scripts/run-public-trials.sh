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

safe_relative() {
  case "$1" in
    /*|*..*|*//*|'') return 1 ;;
    *) return 0 ;;
  esac
}

[ -d "$KIT" ] && [ ! -L "$KIT" ] || fail 'trial-kit directory is missing or is a symlink'
[ -f "$KIT/trial-manifest.json" ] || fail 'trial manifest is missing'
command -v jq >/dev/null 2>&1 || fail 'jq is required'
if find "$KIT" -type l -print | grep -q .; then
  fail 'trial kit contains a symlink'
fi
manifest_runner=$(jq -r '.runner_binary_sha256' "$KIT/trial-manifest.json")
jq -e --arg runner "$manifest_runner" '
  .schema == "revia.public-trial-kit@1.1.0" and
  .runner == "./bin/revia" and
  (.runner_binary_sha256 | test("^[0-9a-f]{64}$")) and
  (.trials | type == "array" and length > 0) and
  all(.trials[];
    (has("command") | not) and (has("expected") | not) and
    .runner_binary_sha256 == $runner and
    (.steps | type == "array" and length > 0) and
    all(.steps[];
      (.command | type == "array" and length > 1) and
      (.expected.exit_status | type == "number") and
      (.expected.stdout_sha256 | test("^[0-9a-f]{64}$")) and
      (.expected.stderr_sha256 | test("^[0-9a-f]{64}$")) and
      (.expected.results | type == "array")))
' "$KIT/trial-manifest.json" >/dev/null || fail 'trial manifest step contract is invalid'

case "$EXECUTABLE" in
  /*) ;;
  *) EXECUTABLE=$(CDPATH= cd -- "$(dirname -- "$EXECUTABLE")" && pwd)/$(basename -- "$EXECUTABLE") ;;
esac
[ -x "$EXECUTABLE" ] || fail "runner is not executable: $EXECUTABLE"
[ "$(sha256_file "$EXECUTABLE")" = "$manifest_runner" ] || fail 'runner binary digest mismatch'

BASE=$(mktemp -d "${TMPDIR:-/tmp}/revia-public-trials.XXXXXX")
trap 'rm -rf "$BASE"' EXIT HUP INT TERM
TRIALS=$(jq -r '.trials | length' "$KIT/trial-manifest.json")

trial=0
while [ "$trial" -lt "$TRIALS" ]; do
  id=$(jq -r --argjson trial "$trial" '.trials[$trial].id' "$KIT/trial-manifest.json")
  safe_relative "$id" || fail "unsafe trial id: $id"
  run_dir="$BASE/$id"
  mkdir -p "$run_dir"
  cp -R "$KIT"/. "$run_dir"/
  mkdir -p "$run_dir/bin"
  cp "$EXECUTABLE" "$run_dir/bin/revia"
  chmod 755 "$run_dir/bin/revia"
  steps=$(jq -r --argjson trial "$trial" '.trials[$trial].steps | length' "$KIT/trial-manifest.json")

  step=0
  while [ "$step" -lt "$steps" ]; do
    command_json=$(jq -c --argjson trial "$trial" --argjson step "$step" '.trials[$trial].steps[$step].command' "$KIT/trial-manifest.json")
    [ "$(printf '%s' "$command_json" | jq -r '.[0]')" = './bin/revia' ] || fail "$id step $step runner mismatch"
    command_shell=$(printf '%s' "$command_json" | jq -r '. | map(@sh) | join(" ")')
    expected_status=$(jq -r --argjson trial "$trial" --argjson step "$step" '.trials[$trial].steps[$step].expected.exit_status' "$KIT/trial-manifest.json")
    expected_stdout=$(jq -r --argjson trial "$trial" --argjson step "$step" '.trials[$trial].steps[$step].expected.stdout_sha256' "$KIT/trial-manifest.json")
    expected_stderr=$(jq -r --argjson trial "$trial" --argjson step "$step" '.trials[$trial].steps[$step].expected.stderr_sha256' "$KIT/trial-manifest.json")
    stdout="$run_dir/stdout-$step"
    stderr="$run_dir/stderr-$step"
    status_file="$run_dir/status-$step"
    (
      cd "$run_dir"
      set +e
      eval "set -- $command_shell"
      "$@" >"$stdout" 2>"$stderr"
      status=$?
      set -e
      printf '%s\n' "$status" >"$status_file"
    )
    actual_status=$(cat "$status_file")
    [ "$actual_status" = "$expected_status" ] || fail "$id step $step exit status mismatch"
    [ "$(sha256_file "$stdout")" = "$expected_stdout" ] || fail "$id step $step stdout digest mismatch"
    [ "$(sha256_file "$stderr")" = "$expected_stderr" ] || fail "$id step $step stderr digest mismatch"

    result_count=$(jq -r --argjson trial "$trial" --argjson step "$step" '.trials[$trial].steps[$step].expected.results | length' "$KIT/trial-manifest.json")
    result=0
    while [ "$result" -lt "$result_count" ]; do
      path=$(jq -r --argjson trial "$trial" --argjson step "$step" --argjson result "$result" '.trials[$trial].steps[$step].expected.results[$result].path' "$KIT/trial-manifest.json")
      fixture=$(jq -r --argjson trial "$trial" --argjson step "$step" --argjson result "$result" '.trials[$trial].steps[$step].expected.results[$result].fixture' "$KIT/trial-manifest.json")
      expected=$(jq -r --argjson trial "$trial" --argjson step "$step" --argjson result "$result" '.trials[$trial].steps[$step].expected.results[$result].sha256' "$KIT/trial-manifest.json")
      safe_relative "$path" && safe_relative "$fixture" || fail "$id step $step contains an unsafe result path"
      [ -f "$run_dir/$path" ] && [ ! -L "$run_dir/$path" ] || fail "$id step $step result is missing: $path"
      [ -f "$run_dir/$fixture" ] && [ ! -L "$run_dir/$fixture" ] || fail "$id step $step fixture is missing: $fixture"
      [ "$(sha256_file "$run_dir/$path")" = "$expected" ] || fail "$id step $step result digest mismatch: $path"
      cmp -s "$run_dir/$path" "$run_dir/$fixture" || fail "$id step $step result differs from fixture: $path"
      result=$((result + 1))
    done
    printf '%s\n' "verified $id step $((step + 1))/$steps"
    step=$((step + 1))
  done
  trial=$((trial + 1))
done

printf '%s\n' "public trials verified: $TRIALS"
