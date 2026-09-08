#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  printf '%s\n' 'Usage: run-reviewed-file-plan.sh <plan.re> <decision.json> <empty-sandbox>' >&2
  exit 64
fi

PLAN=$1
DECISION=$2
SANDBOX=$3
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EXECUTABLE=${REVIA_EXECUTABLE:-"$ROOT/bin/revia"}

fail() {
  printf 'reviewed file plan failed: %s\n' "$1" >&2
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

command -v jq >/dev/null 2>&1 || fail 'jq is required'
[ -f "$PLAN" ] && [ ! -L "$PLAN" ] || fail 'plan must be a regular non-symlink file'
[ -f "$DECISION" ] && [ ! -L "$DECISION" ] || fail 'decision must be a regular non-symlink file'
[ -d "$SANDBOX" ] && [ ! -L "$SANDBOX" ] || fail 'sandbox must be a regular directory'
[ -x "$EXECUTABLE" ] || fail "runner is not executable: $EXECUTABLE"
if find "$SANDBOX" -mindepth 1 -print | grep -q .; then
  fail 'sandbox must be empty before execution'
fi

jq -e '
  type == "object" and
  (keys == ["decision","expected_effects","input_sha256","schema","source_sha256"]) and
  .schema == "revia.reviewed-file-plan-decision@1.0.0" and
  (.decision == "approved" or .decision == "denied") and
  (.source_sha256 | test("^[0-9a-f]{64}$")) and
  (.input_sha256 | test("^[0-9a-f]{64}$")) and
  (.expected_effects | type == "array" and length > 0) and
  all(.expected_effects[];
    (keys == ["path","sha256"]) and
    (.path | type == "string" and length > 0) and
    (.sha256 | test("^[0-9a-f]{64}$")))
' "$DECISION" >/dev/null || fail 'decision contract is invalid'

declared_source=$(jq -r '.source_sha256' "$DECISION")
actual_source=$(sha256_file "$PLAN")
[ "$declared_source" = "$actual_source" ] || fail 'approval is stale for this plan source'

effects=$(jq -r '.expected_effects[].path' "$DECISION")
[ "$(printf '%s\n' "$effects" | LC_ALL=C sort -u)" = "$(printf '%s\n' "$effects" | LC_ALL=C sort)" ] \
  || fail 'duplicate expected effect path'
printf '%s\n' "$effects" | while IFS= read -r path; do
  case "$path" in
    /*|*..*|*//*|'') fail "unsafe effect path: $path" ;;
  esac
done

decision=$(jq -r '.decision' "$DECISION")
if [ "$decision" = denied ]; then
  jq -cnS --arg source "$actual_source" '{decision:"denied",effect:"not-run",schema:"revia.reviewed-file-plan-result@1.0.0",source_sha256:$source}'
  exit 0
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/revia-reviewed-plan.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
"$EXECUTABLE" runtime-package "$PLAN" "$WORK/plan.bundle.json" >"$WORK/package.json"
input=$(jq -r '.input_sha256' "$DECISION")
"$EXECUTABLE" runtime-run "$WORK/plan.bundle.json" "sha256:$input" "$SANDBOX" >"$WORK/run.json"

actual_paths=$(find "$SANDBOX" -type f | while IFS= read -r path; do
  printf '%s\n' "${path#"$SANDBOX"/}"
done | LC_ALL=C sort)
expected_paths=$(printf '%s\n' "$effects" | LC_ALL=C sort)
[ "$actual_paths" = "$expected_paths" ] || fail 'sandbox effect inventory mismatch'

jq -c '.expected_effects[]' "$DECISION" | while IFS= read -r effect; do
  path=$(printf '%s' "$effect" | jq -r '.path')
  expected=$(printf '%s' "$effect" | jq -r '.sha256')
  [ -f "$SANDBOX/$path" ] && [ ! -L "$SANDBOX/$path" ] || fail "effect is missing: $path"
  [ "$(sha256_file "$SANDBOX/$path")" = "$expected" ] || fail "effect digest mismatch: $path"
done

run_digest=$(sha256_file "$WORK/run.json")
jq -cnS --arg run "$run_digest" --arg source "$actual_source" '{decision:"approved",effect:"executed",run_result_sha256:$run,schema:"revia.reviewed-file-plan-result@1.0.0",source_sha256:$source}'
