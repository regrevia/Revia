#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

VERSION=$(sed -n '1p' VERSION)
test "$VERSION" = "0.1-preview.1"
grep -Fq 'Revia is an early technical preview. The project name is provisional and trademark registration is pending.' README.md
grep -Fq 'compiler and runtime source code are not published here' README.md
sh -n bin/revia
grep -Fq '*.re text eol=lf' .gitattributes
grep -Fq 'windows-arm64' bin/revia.ps1
grep -Fq 'windows-x64' bin/revia.ps1
for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64 windows-arm64 windows-x64; do
  grep -Fq "target: $target" .github/workflows/release-smoke.yml
done

for path in README.md QUICKSTART.md RELEASE_NOTES.md LICENSE NOTICE.md VERSION \
  runtime/checksums.txt feedback/FEEDBACK_TEMPLATE.md docs/language.md \
  runtime/build-metadata.json runtime/NODE_LICENSE runtime/PKG_LICENSE \
  runtime/PKG_FETCH_LICENSE docs/protocol.md bin/revia.ps1 .gitattributes \
  docs/agent-workflow.md docs/compatibility.md; do
  test -f "$path"
done

FORBIDDEN=$(find . -path './.git' -prune -o -type f \
  \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.ts' \
     -o -name '*.tsx' -o -name '*.c' -o -name '*.cc' -o -name '*.cpp' \
     -o -name '*.rs' -o -name '*.go' -o -name '*.py' -o -name '*.map' \) \
  -print)
if [ -n "$FORBIDDEN" ]; then
  printf '%s\n' 'Forbidden implementation/source-map files:' "$FORBIDDEN" >&2
  exit 1
fi

if grep -R -I -n -E '/Users/[^/]+/|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_|ghp_[A-Za-z0-9]|sk-[A-Za-z0-9_-]{20,}|V1-DESIGN|RELAY_STATE|COORDINATOR_GUIDANCE' \
  --exclude-dir=.git --exclude=validate-public-tree.sh .; then
  printf '%s\n' 'Private path, credential-like value, or internal governance marker found.' >&2
  exit 1
fi

for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64 windows-arm64 windows-x64; do
  case "$target" in
    windows-*) extension=zip ;;
    *) extension=tar.gz ;;
  esac
  asset="revia-$VERSION-$target.$extension"
  archive_checksum=$(awk -v name="$asset" '$2 == name { print $1 }' runtime/checksums.txt)
  binary_checksum=$(awk -v name="${asset%.$extension}" '$2 == name { print $1 }' runtime/checksums.txt)
  printf '%s' "$archive_checksum" | grep -Eq '^[0-9a-f]{64}$'
  printf '%s' "$binary_checksum" | grep -Eq '^[0-9a-f]{64}$'
done

for report in feedback/submissions/*.md; do
  [ -e "$report" ] || continue
  basename "$report" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md$'
  for heading in '## Use Environment' '## Installation Method' \
    '## `.re` Project Used' '## Successful Steps' '## Failed Steps' \
    '## Error Information' '## Generated Artifacts' \
    '## Language Suggestions' '## Would You Continue Using Revia?'; do
    grep -Fq "$heading" "$report"
  done
done

printf '%s\n' 'public tree validation passed'
