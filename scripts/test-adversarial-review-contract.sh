#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/revia-adversarial.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

test -f examples/adversarial-review/README.md
for case_dir in \
  examples/adversarial-review/case-01-two-sum \
  examples/adversarial-review/case-02-retry-counter \
  examples/adversarial-review/case-03-handoff-report
do
  test -f "$case_dir/main.re"
  test -f "$case_dir/README.md"
  grep -Fq 'revia manifest' "$case_dir/README.md"
  grep -Fq 'revia execute' "$case_dir/README.md"
  digest=$(./bin/revia digest "$case_dir/main.re")
  ./bin/revia check "$case_dir/main.re"
  name=$(basename "$case_dir")
  ./bin/revia translate "$case_dir/main.re" >"$TMP/$name.translate.txt"
  ./bin/revia compile "$case_dir/main.re" "$TMP/$name.artifact" >"$TMP/$name.compile.json"
  ./bin/revia execute "$case_dir/main.re" "$digest" >"$TMP/$name.execute.json"
  ./bin/revia manifest "$case_dir/main.re" >"$TMP/$name.manifest.json"
  grep -Fq 're 0.1 bytecode' "$TMP/$name.translate.txt"
  jq empty "$TMP/$name.compile.json" "$TMP/$name.execute.json" \
    "$TMP/$name.manifest.json"
  test -s "$TMP/$name.artifact"
done

if git ls-files --error-unmatch .private/adversarial-review >/dev/null 2>&1; then
  printf '%s\n' 'private adversarial answer directory is tracked' >&2
  exit 1
fi

printf '%s\n' 'adversarial review contract passed'
