#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EXECUTABLE=${REVIA_EXECUTABLE:-"$ROOT/bin/revia"}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/revia-json-contract.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

case "$EXECUTABLE" in
  /*) ;;
  *) EXECUTABLE=$(CDPATH= cd -- "$(dirname -- "$EXECUTABLE")" && pwd)/$(basename -- "$EXECUTABLE") ;;
esac

if [ ! -x "$EXECUTABLE" ]; then
  printf '%s\n' "JSON contract check cannot execute: $EXECUTABLE" >&2
  exit 70
fi
command -v jq >/dev/null 2>&1 || {
  printf '%s\n' 'JSON contract check requires jq.' >&2
  exit 70
}

if [ "$(sed -n '1p' "$ROOT/VERSION")" = '1.0.0-rc.1' ]; then
  jq -e '
    .schema == "re.native-release-candidate@0.1.0" and
    .version == "1.0.0-rc.1" and
    .target == "darwin-arm64" and
    (.files | length) == 4
  ' "$ROOT/runtime/rc1/candidate-manifest.json" >/dev/null
  jq -e '
    .schema == "revia.public-trial-kit@1.0.0" and
    .version == "1.0.0-rc.1" and
    .target == "darwin-arm64" and
    (.trials | length) == 7
  ' "$ROOT/runtime/rc1/trial-manifest.json" >/dev/null
  printf '%s\n' 'RC1 public JSON contracts passed'
  exit 0
fi

"$EXECUTABLE" check --format json "$ROOT/examples/hello.re" >"$TMP/check-ok.json"
jq -e '
  type == "object" and
  .schema == "re.check-result@0.1.0" and
  (.ok | type) == "boolean" and
  (.file | type) == "string" and
  (.diagnostics | type) == "array" and
  .ok == true
' "$TMP/check-ok.json" >/dev/null

set +e
"$EXECUTABLE" check --format json "$ROOT/examples/diagnostic-error.re" >"$TMP/check-error.json"
status=$?
set -e
test "$status" -eq 65
jq -e '
  .schema == "re.check-result@0.1.0" and
  .ok == false and
  (.diagnostics | length) > 0 and
  .diagnostics[0].code == "unexpected-argument"
' "$TMP/check-error.json" >/dev/null

"$EXECUTABLE" audit --format json "$ROOT/examples/agent-args-policy.re" >"$TMP/audit.json"
jq -e '
  type == "object" and
  .schema == "re.audit-result@0.1.0" and
  (.capabilities | type) == "array" and
  (.effects | type) == "array" and
  (.error_paths | type) == "array" and
  (.status_codes | type) == "array" and
  ([.status_codes[] | select(type != "number")] | length) == 0 and
  (has("ok") | not)
' "$TMP/audit.json" >/dev/null

printf '%s\n' 'runtime JSON contracts passed'
