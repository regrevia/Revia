#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

version=$(./bin/revia --version)
test "$version" = "revia $(sed -n '1p' VERSION)"

help=$(./bin/revia --help)
printf '%s\n' "$help" | grep -Fq 'Usage: revia <command>'
if printf '%s\n' "$help" | grep -Fq 'project-check'; then
  printf '%s\n' 'project-check must not be listed in public launcher help.' >&2
  exit 1
fi
if printf '%s\n' "$help" | grep -Fq 'project-run'; then
  printf '%s\n' 'project-run must not be listed in public launcher help.' >&2
  exit 1
fi

check_help=$(./bin/revia check --help)
test "$check_help" = 'Usage: revia check [--format json | --write] <file.re>'

link_dir=$(mktemp -d "${TMPDIR:-/tmp}/revia-launcher-test.XXXXXX")
cache_dir=$(mktemp -d "${TMPDIR:-/tmp}/revia-launcher-cache.XXXXXX")
tool_dir=$(mktemp -d "${TMPDIR:-/tmp}/revia-launcher-path.XXXXXX")
trap 'rm -rf "$link_dir" "$cache_dir" "$tool_dir"' EXIT HUP INT TERM
ln -s "$ROOT/bin/revia" "$link_dir/revia"
test "$("$link_dir/revia" --version)" = "revia $(sed -n '1p' VERSION)"

case "$(sed -n '1p' VERSION)" in
  0.1-preview.1)
    for tool in awk dirname mktemp rm sed shasum uname; do
      source=$(command -v "$tool")
      ln -s "$source" "$tool_dir/$tool"
    done
    set +e
    XDG_CACHE_HOME="$cache_dir" PATH="$tool_dir" ./bin/revia check examples/agent-review/main.re >/tmp/revia-no-curl.out 2>&1
    status=$?
    set -e
    test "$status" -eq 70
    grep -Fq 'Revia requires curl' /tmp/revia-no-curl.out
    ;;
  1.0.0-rc.1)
    set +e
    ./bin/revia check examples/agent-review/main.re >/tmp/revia-pending-target.out 2>&1
    status=$?
    set -e
    test "$status" -eq 69
    grep -Fqi 'pending target' /tmp/revia-pending-target.out
    ;;
esac

grep -Fq 'while [ -h "$SOURCE" ]' bin/revia
grep -Fq "command -v curl" bin/revia
grep -Fq "Release download failed." bin/revia
grep -Fq "Release archive could not be unpacked" bin/revia
! grep -Fq '$IsWindows' bin/revia.ps1
grep -Fq 'PROCESSOR_ARCHITEW6432' bin/revia.ps1
grep -Fq 'Get-ReviaRoot' bin/revia.ps1

printf '%s\n' 'launcher checks passed'
