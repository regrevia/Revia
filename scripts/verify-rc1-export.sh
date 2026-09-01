#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: verify-rc1-export.sh <sealed-export-directory>' >&2
  exit 64
fi

EXPORT=$1
VERSION=1.0.0-rc.1
TARGET=darwin-arm64
ARCHIVE="revia-$VERSION-$TARGET.tar.gz"

fail() {
  printf 'RC1 export verification failed: %s\n' "$1" >&2
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
command -v tar >/dev/null 2>&1 || fail 'tar is required'
[ -d "$EXPORT" ] || fail 'export directory is missing'
[ ! -L "$EXPORT" ] || fail 'export directory must not be a symlink'

EXPECTED=$(printf '%s\n' \
  LICENSE-RC.md \
  NOTICE-RC.md \
  candidate-manifest.json \
  capability-evidence.json \
  checksums.txt \
  export-manifest.json \
  multi-module-evidence.json \
  native-evidence.json \
  "$ARCHIVE" \
  server-evidence.json \
  target-matrix.json | LC_ALL=C sort)

if find "$EXPORT" -mindepth 1 -maxdepth 1 \( -type l -o ! -type f \) -print | grep -q .; then
  fail 'only declared regular files are allowed'
fi
ACTUAL=$(find "$EXPORT" -mindepth 1 -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort)
[ "$ACTUAL" = "$EXPECTED" ] || fail 'exact file inventory mismatch'

if find "$EXPORT" -type f \( \
  -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.ts' -o \
  -name '*.tsx' -o -name '*.rs' -o -name '*.go' -o -name '*.py' -o \
  -name '*.c' -o -name '*.cc' -o -name '*.cpp' -o -name '*.map' \
\) -print | grep -q .; then
  fail 'implementation source or source map is forbidden'
fi

if grep -R -I -a -n -E '/Users/[^/]+/|/home/[^/]+/|[A-Za-z]:\\Users\\|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_|ghp_[A-Za-z0-9]|sk-[A-Za-z0-9_-]{20,}|V1-DESIGN|RELAY_STATE|COORDINATOR_GUIDANCE' "$EXPORT" >/dev/null; then
  fail 'private path, credential-like value, or governance marker found'
fi

for json in export-manifest.json candidate-manifest.json target-matrix.json \
  native-evidence.json capability-evidence.json multi-module-evidence.json \
  server-evidence.json; do
  jq -e . "$EXPORT/$json" >/dev/null || fail "$json is not valid JSON"
  canonical=$(mktemp "${TMPDIR:-/tmp}/revia-rc1-json.XXXXXX") || fail 'temporary file creation failed'
  jq -cS . "$EXPORT/$json" > "$canonical"
  if ! cmp -s "$canonical" "$EXPORT/$json"; then
    rm -f "$canonical"
    fail "$json is not canonical compact JSON"
  fi
  rm -f "$canonical"
done

MANIFEST=$EXPORT/export-manifest.json
jq -e --arg version "$VERSION" --arg target "$TARGET" \
  '.schema == "revia.public-rc-export@1.0.0" and
   .version == $version and .tag == ("v" + $version) and
   .target == $target and .status == "measured-native" and
   (.files | type == "array" and length == 10)' "$MANIFEST" >/dev/null \
  || fail 'export manifest identity mismatch'

PAYLOADS=$(printf '%s\n' \
  LICENSE-RC.md NOTICE-RC.md candidate-manifest.json capability-evidence.json \
  checksums.txt multi-module-evidence.json native-evidence.json "$ARCHIVE" \
  server-evidence.json target-matrix.json | LC_ALL=C sort)
LISTED=$(jq -r '.files[].path' "$MANIFEST" | LC_ALL=C sort)
[ "$LISTED" = "$PAYLOADS" ] || fail 'manifest payload inventory mismatch'

printf '%s\n' "$PAYLOADS" | while IFS= read -r name; do
  listed_count=$(jq -r --arg path "$name" '[.files[] | select(.path == $path)] | length' "$MANIFEST")
  [ "$listed_count" -eq 1 ] || fail "manifest entry count mismatch for $name"
  expected_hash=$(jq -r --arg path "$name" '.files[] | select(.path == $path) | .sha256' "$MANIFEST")
  expected_size=$(jq -r --arg path "$name" '.files[] | select(.path == $path) | .size' "$MANIFEST")
  printf '%s' "$expected_hash" | grep -Eq '^[0-9a-f]{64}$' || fail "invalid hash for $name"
  [ "$expected_hash" = "$(sha256_file "$EXPORT/$name")" ] || fail "hash mismatch for $name"
  [ "$expected_size" -eq "$(wc -c < "$EXPORT/$name" | tr -d ' ')" ] || fail "size mismatch for $name"
done

jq -e --arg version "$VERSION" --arg target "$TARGET" \
  '.version == $version and .target == $target' \
  "$EXPORT/candidate-manifest.json" >/dev/null || fail 'candidate identity mismatch'

jq -e --arg version "$VERSION" '
  .schema == "revia.public-target-matrix@1.0.0" and .version == $version and
  (.targets | length == 6) and
  ([.targets[] | select(.target == "darwin-arm64" and .status == "measured-native")] | length == 1) and
  ([.targets[] | select(.target == "darwin-x64" and .status == "pending")] | length == 1) and
  ([.targets[] | select(.target == "linux-arm64" and .status == "pending")] | length == 1) and
  ([.targets[] | select(.target == "linux-x64" and .status == "pending")] | length == 1) and
  ([.targets[] | select(.target == "windows-arm64" and .status == "pending")] | length == 1) and
  ([.targets[] | select(.target == "windows-x64" and .status == "pending")] | length == 1)
' "$EXPORT/target-matrix.json" >/dev/null || fail 'target matrix mismatch'

for evidence in native-evidence.json capability-evidence.json \
  multi-module-evidence.json server-evidence.json; do
  jq -e --arg version "$VERSION" --arg target "$TARGET" \
    '.version == $version and .target == $target and .status == "measured-native" and (.schema | type == "string")' \
    "$EXPORT/$evidence" >/dev/null || fail "$evidence identity mismatch"
done

ARCHIVE_HASH=$(awk -v name="$ARCHIVE" '$2 == name { print $1 }' "$EXPORT/checksums.txt")
BINARY_NAME="revia-$VERSION-$TARGET"
BINARY_HASH=$(awk -v name="$BINARY_NAME" '$2 == name { print $1 }' "$EXPORT/checksums.txt")
[ "$(wc -l < "$EXPORT/checksums.txt" | tr -d ' ')" -eq 2 ] || fail 'checksums must contain exactly archive and binary entries'
[ "$ARCHIVE_HASH" = "$(sha256_file "$EXPORT/$ARCHIVE")" ] || fail 'archive checksum mismatch'
printf '%s' "$BINARY_HASH" | grep -Eq '^[0-9a-f]{64}$' || fail 'binary checksum is invalid'

CONTENTS=$(tar -tzf "$EXPORT/$ARCHIVE" | sed 's#^\./##' | LC_ALL=C sort)
EXPECTED_CONTENTS=$(printf '%s\n' LICENSE NOTICE checksums.sha256 manifest.json release-lock.json revia | LC_ALL=C sort)
[ "$CONTENTS" = "$EXPECTED_CONTENTS" ] || fail 'archive inventory mismatch'

UNPACK=$(mktemp -d "${TMPDIR:-/tmp}/revia-rc1-unpack.XXXXXX") || fail 'temporary directory creation failed'
trap 'rm -rf "$UNPACK"' EXIT HUP INT TERM
tar -xzf "$EXPORT/$ARCHIVE" -C "$UNPACK"
[ ! -L "$UNPACK/revia" ] && [ -f "$UNPACK/revia" ] || fail 'archive binary is not a regular file'
cmp -s "$EXPORT/LICENSE-RC.md" "$UNPACK/LICENSE" || fail 'archive license mismatch'
cmp -s "$EXPORT/NOTICE-RC.md" "$UNPACK/NOTICE" || fail 'archive notice mismatch'
cmp -s "$EXPORT/candidate-manifest.json" "$UNPACK/manifest.json" || fail 'archive candidate manifest mismatch'
[ "$BINARY_HASH" = "$(sha256_file "$UNPACK/revia")" ] || fail 'binary checksum mismatch'

LICENSE_HASH=$(sha256_file "$EXPORT/LICENSE-RC.md")
[ "$LICENSE_HASH" = "$(jq -r '.license_sha256' "$MANIFEST")" ] || fail 'license digest mismatch'

printf '%s\n' "RC1 sealed export verified: $VERSION $TARGET $ARCHIVE_HASH"
