#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: verify-rc1-release-assets.sh <tag>' >&2
  exit 64
fi

TAG=$1
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(sed -n '1p' "$ROOT/VERSION")
[ "$TAG" = "v$VERSION" ] || { printf '%s\n' 'release asset tag/version mismatch' >&2; exit 65; }

command -v gh >/dev/null 2>&1 || { printf '%s\n' 'gh is required' >&2; exit 69; }
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'jq is required' >&2; exit 69; }
command -v tar >/dev/null 2>&1 || { printf '%s\n' 'tar is required' >&2; exit 69; }

EXPECTED=$(cat <<EOF
candidate-manifest.json
capability-evidence.json
checksums.txt
export-manifest.json
LICENSE-RC.md
multi-module-evidence.json
native-evidence.json
NOTICE-RC.md
revia-$VERSION-darwin-arm64.tar.gz
revia-$VERSION-trial-kit.tar.gz
server-evidence.json
target-matrix.json
trial-manifest.json
EOF
)

BASE=$(mktemp -d "${TMPDIR:-/tmp}/revia-rc1-assets.XXXXXX")
trap 'rm -rf "$BASE"' EXIT HUP INT TERM
REPO=${GITHUB_REPOSITORY:-tangshuang631/Revia}
release=$(gh release view "$TAG" --repo "$REPO" --json isDraft,isPrerelease,tagName,assets)
printf '%s' "$release" | jq -e --arg tag "$TAG" \
  '.isDraft == true and .isPrerelease == true and .tagName == $tag and (.assets | length == 12)' >/dev/null \
  || { printf '%s\n' 'release must be a 12-asset prerelease draft' >&2; exit 65; }

ACTUAL=$(printf '%s' "$release" | jq -r '.assets[].name' | LC_ALL=C sort)
[ "$ACTUAL" = "$(printf '%s\n' "$EXPECTED" | LC_ALL=C sort)" ] \
  || { printf '%s\n' 'release asset inventory mismatch' >&2; exit 65; }

while IFS= read -r asset; do
  [ -n "$asset" ] || continue
  gh release download "$TAG" --repo "$REPO" --pattern "$asset" --dir "$BASE" >/dev/null
done <<EOF
$EXPECTED
EOF

for file in candidate-manifest.json capability-evidence.json checksums.txt \
  export-manifest.json LICENSE-RC.md multi-module-evidence.json native-evidence.json \
  NOTICE-RC.md server-evidence.json target-matrix.json trial-manifest.json; do
  case "$file" in
    trial-manifest.json) expected="$ROOT/experiments/rc1/kit/$file" ;;
    checksums.txt) expected="$ROOT/runtime/checksums.txt" ;;
    *) expected="$ROOT/runtime/rc1/$file" ;;
  esac
  cmp -s "$BASE/$file" "$expected" || { printf 'release asset differs: %s\n' "$file" >&2; exit 65; }
done

archive="revia-$VERSION-darwin-arm64.tar.gz"
expected_archive=$(awk -v name="$archive" '$2 == name { print $1 }' "$ROOT/runtime/checksums.txt")
if command -v sha256sum >/dev/null 2>&1; then
  actual_archive=$(sha256sum "$BASE/$archive" | awk '{print $1}')
else
  actual_archive=$(shasum -a 256 "$BASE/$archive" | awk '{print $1}')
fi
[ "$actual_archive" = "$expected_archive" ] || { printf '%s\n' 'runtime archive checksum mismatch' >&2; exit 65; }

kit="revia-$VERSION-trial-kit.tar.gz"
tar -tzf "$BASE/$kit" >/dev/null || { printf '%s\n' 'trial-kit archive is unreadable' >&2; exit 65; }
KIT_DIR="$BASE/kit"
mkdir -p "$KIT_DIR"
tar -xzf "$BASE/$kit" -C "$KIT_DIR"
trial_root=$(find "$KIT_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit)
[ -n "$trial_root" ] || trial_root="$KIT_DIR"
"$ROOT/scripts/verify-rc1-trial-kit.sh" "$trial_root" "$ROOT/runtime/rc1/export-manifest.json" >/dev/null

printf '%s\n' "RC1 release assets verified: $TAG"
