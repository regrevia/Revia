#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  printf '%s\n' 'Usage: verify-rc1-trial-kit.sh <trial-kit-directory> <accepted-export-manifest>' >&2
  exit 64
fi

KIT=$1
EXPORT_MANIFEST=$2
VERSION=1.0.0-rc.1
TARGET=darwin-arm64

fail() {
  printf 'RC1 trial-kit verification failed: %s\n' "$1" >&2
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
  case "$1" in /*|*..*|*//*|'') return 1 ;; *) return 0 ;; esac
}

command -v jq >/dev/null 2>&1 || fail 'jq is required'
[ -d "$KIT" ] && [ ! -L "$KIT" ] || fail 'trial-kit directory is missing or is a symlink'
[ -f "$EXPORT_MANIFEST" ] && [ ! -L "$EXPORT_MANIFEST" ] || fail 'accepted export manifest is missing'
find "$KIT" -type l -print | grep -q . && fail 'symlinks are forbidden'
find "$KIT" -type f ! \( -name '*.md' -o -name '*.json' -o -name '*.re' -o -name '*.txt' \) -print | grep -q . \
  && fail 'trial kit contains a forbidden file type'

MANIFEST=$KIT/trial-manifest.json
CHECKSUMS=$KIT/checksums.txt
[ -f "$MANIFEST" ] && [ -f "$CHECKSUMS" ] || fail 'manifest or checksums missing'
canonical=$(mktemp "${TMPDIR:-/tmp}/revia-rc1-trial-json.XXXXXX")
trap 'rm -f "$canonical"' EXIT HUP INT TERM
jq -cS . "$MANIFEST" >"$canonical"
cmp -s "$canonical" "$MANIFEST" || fail 'trial manifest is not canonical compact JSON'

jq -e --arg version "$VERSION" --arg target "$TARGET" '
  .schema == "revia.public-trial-kit@1.1.0" and
  .version == $version and .target == $target and
  .status == "measured-native" and .runner == "./bin/revia" and
  (.runner_binary_sha256 | test("^[0-9a-f]{64}$")) and
  (.files | type == "array") and (.trials | type == "array" and length == 7) and
  all(.trials[];
    (has("command") | not) and (has("expected") | not) and
    .status == "measured-native" and .cwd == "." and
    (.steps | type == "array" and length > 0) and
    all(.steps[];
      (.command | type == "array" and length > 1 and .[0] == "./bin/revia") and
      (.expected | keys == ["exit_status","results","stderr_sha256","stdout_sha256"]) and
      (.expected.exit_status | type == "number") and
      (.expected.stdout_sha256 | test("^[0-9a-f]{64}$")) and
      (.expected.stderr_sha256 | test("^[0-9a-f]{64}$")) and
      (.expected.results | type == "array") and
      all(.expected.results[];
        (keys == ["fixture","path","sha256"]) and
        (.path | type == "string" and length > 0) and
        (.fixture | type == "string" and length > 0) and
        (.sha256 | test("^[0-9a-f]{64}$")))))
' "$MANIFEST" >/dev/null || fail 'trial manifest identity or step contract mismatch'

project_steps=$(jq -c '.trials[] | select(.id == "project-workflow") | [.steps[].command[1]]' "$MANIFEST")
[ "$project_steps" = '["project-init","project-check","project-test"]' ] \
  || fail 'project-workflow must execute init, check, and test in order'

RUNNER_HASH=$(jq -r '.runner_binary_sha256' "$MANIFEST")
accepted=$(awk '$2 == "revia-1.0.0-rc.1-darwin-arm64" { print $1 }' "$(dirname "$EXPORT_MANIFEST")/checksums.txt" 2>/dev/null || true)
if [ -z "$accepted" ]; then
  accepted=$(awk '$2 == "revia-1.0.0-rc.1-darwin-arm64" { print $1 }' "$(dirname "$EXPORT_MANIFEST")/../checksums.txt" 2>/dev/null || true)
fi
[ "$RUNNER_HASH" = "$accepted" ] || fail 'trial runner digest differs from accepted candidate'

DECLARED=$(jq -r '.files[].path' "$MANIFEST" | LC_ALL=C sort)
ACTUAL=$(find "$KIT" -type f | while IFS= read -r path; do
  relative=${path#"$KIT"/}
  [ "$relative" = trial-manifest.json ] || [ "$relative" = checksums.txt ] || printf '%s\n' "$relative"
done | LC_ALL=C sort)
[ "$DECLARED" = "$ACTUAL" ] || fail 'declared trial payload inventory mismatch'

printf '%s\n' "$DECLARED" | while IFS= read -r path; do
  safe_relative "$path" || fail "unsafe fixture path: $path"
  expected=$(jq -r --arg path "$path" '.files[] | select(.path == $path) | .sha256' "$MANIFEST")
  [ "$expected" = "$(sha256_file "$KIT/$path")" ] || fail "fixture hash mismatch: $path"
done

jq -c '.trials[].steps[].expected.results[]' "$MANIFEST" | while IFS= read -r result; do
  path=$(printf '%s' "$result" | jq -r '.path')
  fixture=$(printf '%s' "$result" | jq -r '.fixture')
  expected=$(printf '%s' "$result" | jq -r '.sha256')
  safe_relative "$path" && safe_relative "$fixture" || fail 'unsafe result binding path'
  [ -f "$KIT/$fixture" ] || fail "result fixture is missing: $fixture"
  [ "$(sha256_file "$KIT/$fixture")" = "$expected" ] || fail "result fixture digest mismatch: $fixture"
done

EXPECTED_CHECKSUM_PATHS=$(printf '%s\n' trial-manifest.json "$DECLARED" | LC_ALL=C sort)
ACTUAL_CHECKSUM_PATHS=$(awk '{ print $2 }' "$CHECKSUMS" | LC_ALL=C sort)
[ "$EXPECTED_CHECKSUM_PATHS" = "$ACTUAL_CHECKSUM_PATHS" ] || fail 'trial checksum inventory mismatch'
printf '%s\n' "$EXPECTED_CHECKSUM_PATHS" | while IFS= read -r path; do
  expected=$(awk -v path="$path" '$2 == path { print $1 }' "$CHECKSUMS")
  [ "$expected" = "$(sha256_file "$KIT/$path")" ] || fail "checksum mismatch: $path"
done

printf '%s\n' "RC1 trial kit verified: $VERSION $TARGET $RUNNER_HASH"
