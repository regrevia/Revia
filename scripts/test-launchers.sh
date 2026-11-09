#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

version=$(./bin/revia --version)
test "$version" = "revia $(sed -n '1p' VERSION)"

help=$(./bin/revia --help)
printf '%s\n' "$help" | grep -Fq 'Usage: revia '
printf '%s\n' "$help" | grep -Fq 'project-check <project-dir>'
printf '%s\n' "$help" | grep -Fq 'project-run <project-dir>'
printf '%s\n' "$help" | grep -Fq 'project-translate <project>'
printf '%s\n' "$help" | grep -Fq '[Additional versioned runtime, project, and evidence commands]'
printf '%s\n' "$help" | grep -Fq 'This launcher invokes the versioned native executable. It does not invoke Node.'
printf '%s\n' "$help" | grep -Fq 'The Node reference CLI has a separate source-oriented surface:'

link_dir=$(mktemp -d "${TMPDIR:-/tmp}/revia-launcher-test.XXXXXX")
pending_output=$(mktemp "${TMPDIR:-/tmp}/revia-pending-target.XXXXXX")
trap 'rm -rf "$link_dir" "$pending_output"' EXIT HUP INT TERM
ln -s "$ROOT/bin/revia" "$link_dir/revia"
test "$("$link_dir/revia" --version)" = "revia $(sed -n '1p' VERSION)"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) platform=darwin-arm64 ;;
  Darwin:x86_64) platform=darwin-x64 ;;
  Linux:aarch64|Linux:arm64) platform=linux-arm64 ;;
  Linux:x86_64) platform=linux-x64 ;;
  *) platform=unknown ;;
esac

asset="revia-$(sed -n '1p' VERSION)-$platform"
if [ "$platform" != 'unknown' ] &&
  ! awk -v asset="$asset" '$2 == asset { found = 1 } END { exit !found }' runtime/checksums.txt; then
  # No published asset for this host: the launcher must refuse before any
  # download. The rc.1 candidate is the exception, measured on darwin-arm64.
  if [ "$(sed -n '1p' VERSION)" != '1.0.0-rc.1' ] || [ "$platform" != 'darwin-arm64' ]; then
    set +e
    ./bin/revia check examples/agent-review/main.re >"$pending_output" 2>&1
    status=$?
    set -e
    test "$status" -eq 69
    grep -Fqi 'pending target' "$pending_output"
    grep -Fq 'docs/compatibility.md' "$pending_output"
  fi
fi

grep -Fq 'while [ -h "$SOURCE" ]' bin/revia
grep -Fq "command -v curl" bin/revia
grep -Fq "Release download failed." bin/revia
grep -Fq "Release archive could not be unpacked" bin/revia
! grep -Fq '$IsWindows' bin/revia.ps1
grep -Fq 'PROCESSOR_ARCHITEW6432' bin/revia.ps1
grep -Fq 'Get-ReviaRoot' bin/revia.ps1

printf '%s\n' 'launcher checks passed'
