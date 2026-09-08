#!/bin/sh
set -eu

ROOT=${REVIA_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
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
  "$EXECUTABLE" check "$ROOT/experiments/rc1/kit/fixtures/hello-check/hello.re" >"$TMP/check.json"
  jq -e '
    .schema == "re.native-parser-result@0.1.0" and
    .ok == true and
    (.unit | type == "string") and
    (.capability_count | type == "number") and
    (.statement_count | type == "number")
  ' "$TMP/check.json" >/dev/null
  "$EXECUTABLE" manifest "$ROOT/experiments/rc1/kit/fixtures/agent-review/review.re" >"$TMP/manifest.json"
  jq -e '
    .schema == "re.native-review-manifest@0.1.0" and
    .execution_evidence == "not-collected" and
    (.graph_revision | test("^sha256:[0-9a-f]{64}$")) and
    (.reachable | type == "array") and
    (.executed | type == "array")
  ' "$TMP/manifest.json" >/dev/null
  printf '%s\n' 'RC1 executable JSON contracts passed'
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
