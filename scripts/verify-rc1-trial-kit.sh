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

command -v jq >/dev/null 2>&1 || fail 'jq is required'
[ -d "$KIT" ] && [ ! -L "$KIT" ] || fail 'trial-kit directory is missing or is a symlink'
[ -f "$EXPORT_MANIFEST" ] && [ ! -L "$EXPORT_MANIFEST" ] || fail 'accepted export manifest is missing'

if find "$KIT" -type l -print | grep -q .; then
  fail 'symlinks are forbidden'
fi
if find "$KIT" -type f ! \( -name '*.md' -o -name '*.json' -o -name '*.re' -o -name '*.txt' \) -print | grep -q .; then
  fail 'trial kit contains a forbidden file type'
fi
if find "$KIT" -type d -empty -print | grep -q .; then
  fail 'empty directories are forbidden'
fi
if grep -R -I -n -E '/Users/[^/]+/|/home/[^/]+/|[A-Za-z]:\\Users\\|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_|ghp_[A-Za-z0-9]|sk-[A-Za-z0-9_-]{20,}|V1-DESIGN|RELAY_STATE|COORDINATOR_GUIDANCE' "$KIT" >/dev/null; then
  fail 'private path, credential-like value, or governance marker found'
fi

MANIFEST=$KIT/trial-manifest.json
CHECKSUMS=$KIT/checksums.txt
[ -f "$MANIFEST" ] && [ -f "$CHECKSUMS" ] || fail 'manifest or checksums missing'

canonical=$(mktemp "${TMPDIR:-/tmp}/revia-rc1-trial-json.XXXXXX") || fail 'temporary file creation failed'
jq -cS . "$MANIFEST" > "$canonical"
if ! cmp -s "$canonical" "$MANIFEST"; then
  rm -f "$canonical"
  fail 'trial manifest is not canonical compact JSON'
fi
rm -f "$canonical"

jq -e --arg version "$VERSION" --arg target "$TARGET" '
  .schema == "revia.public-trial-kit@1.0.0" and
  .version == $version and .target == $target and
  .status == "measured-native" and .runner == "./bin/revia" and
  (.runner_binary_sha256 | test("^[0-9a-f]{64}$")) and
  (.files | type == "array") and (.trials | type == "array" and length == 7)
' "$MANIFEST" >/dev/null || fail 'trial manifest identity mismatch'

ARCHIVE_BINARY=$(jq -r '.files[] | select(.path == "revia-1.0.0-rc.1-darwin-arm64.tar.gz") | .sha256' "$EXPORT_MANIFEST")
printf '%s' "$ARCHIVE_BINARY" | grep -Eq '^[0-9a-f]{64}$' || fail 'accepted export archive identity is missing'
RUNNER_HASH=$(jq -r '.runner_binary_sha256' "$MANIFEST")
[ "$RUNNER_HASH" = "$(awk '$2 == "revia-1.0.0-rc.1-darwin-arm64" { print $1 }' "$(dirname "$EXPORT_MANIFEST")/../checksums.txt" 2>/dev/null || true)" ] \
  || [ "$RUNNER_HASH" = "$(awk '$2 == "revia-1.0.0-rc.1-darwin-arm64" { print $1 }' "$(dirname "$EXPORT_MANIFEST")/checksums.txt" 2>/dev/null || true)" ] \
  || fail 'trial runner digest differs from accepted candidate'

DECLARED=$(jq -r '.files[].path' "$MANIFEST" | LC_ALL=C sort)
ACTUAL=$(find "$KIT" -type f | while IFS= read -r path; do
  relative=${path#"$KIT"/}
  if [ "$relative" = trial-manifest.json ] || [ "$relative" = checksums.txt ]; then
    continue
  fi
  printf '%s\n' "$relative"
done | LC_ALL=C sort)
[ "$DECLARED" = "$ACTUAL" ] || fail 'declared trial payload inventory mismatch'

printf '%s\n' "$DECLARED" | while IFS= read -r path; do
  [ -n "$path" ] || fail 'empty fixture path'
  case "$path" in /*) fail "unsafe fixture path: $path" ;; esac
  case "$path" in *..*) fail "unsafe fixture path: $path" ;; esac
  case "$path" in *//*) fail "unsafe fixture path: $path" ;; esac
  count=$(jq -r --arg path "$path" '[.files[] | select(.path == $path)] | length' "$MANIFEST")
  [ "$count" -eq 1 ] || fail "duplicate fixture entry: $path"
  expected=$(jq -r --arg path "$path" '.files[] | select(.path == $path) | .sha256' "$MANIFEST")
  size=$(jq -r --arg path "$path" '.files[] | select(.path == $path) | .size' "$MANIFEST")
  [ "$expected" = "$(sha256_file "$KIT/$path")" ] || fail "fixture hash mismatch: $path"
  [ "$size" -eq "$(wc -c < "$KIT/$path" | tr -d ' ')" ] || fail "fixture size mismatch: $path"
done

EXPECTED_TRIALS=$(printf '%s\n' hello-check agent-review capability-args capability-file project-workflow multi-module bounded-server | LC_ALL=C sort)
ACTUAL_TRIALS=$(jq -r '.trials[].id' "$MANIFEST" | LC_ALL=C sort)
[ "$EXPECTED_TRIALS" = "$ACTUAL_TRIALS" ] || fail 'required trial inventory mismatch'

jq -e '
  all(.trials[];
    .status == "measured-native" and .cwd == "." and
    (.command | type == "array" and length > 1 and .[0] == "./bin/revia") and
    (.fixtures | type == "array" and length > 0) and
    (.prerequisites | type == "array") and
    (.input_sha256 | test("^[0-9a-f]{64}$")) and
    (.expected.exit_status | type == "number") and
    (.expected.stdout_sha256 | test("^[0-9a-f]{64}$")) and
    (.expected.stderr_sha256 | test("^[0-9a-f]{64}$")) and
    (.expected.result_sha256 | test("^[0-9a-f]{64}$")) and
    (.evidence_ref | test("^(native|capability|multi-module|server)-evidence\\.json$"))
  )
' "$MANIFEST" >/dev/null || fail 'one or more trial bindings are incomplete'

EXPECTED_CHECKSUM_PATHS=$(printf '%s\n' trial-manifest.json "$DECLARED" | LC_ALL=C sort)
ACTUAL_CHECKSUM_PATHS=$(awk '{ print $2 }' "$CHECKSUMS" | LC_ALL=C sort)
[ "$EXPECTED_CHECKSUM_PATHS" = "$ACTUAL_CHECKSUM_PATHS" ] || fail 'trial checksum inventory mismatch'

printf '%s\n' "$EXPECTED_CHECKSUM_PATHS" | while IFS= read -r path; do
  expected=$(awk -v path="$path" '$2 == path { print $1 }' "$CHECKSUMS")
  printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$' || fail "invalid checksum: $path"
  [ "$expected" = "$(sha256_file "$KIT/$path")" ] || fail "checksum mismatch: $path"
done

printf '%s\n' "RC1 trial kit verified: $VERSION $TARGET $RUNNER_HASH"
