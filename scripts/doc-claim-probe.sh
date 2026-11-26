#!/usr/bin/env bash
# doc-claim-probe: show, in one command, whether a documentation sentence is
# bound to anything. It edits a clone, runs the repository's own gate, and
# reports whether the gate noticed.
#
#   ./scripts/doc-claim-probe.sh                    # default probe: availability page
#   ./scripts/doc-claim-probe.sh --control          # known-bound control (baseline row)
#   ./scripts/doc-claim-probe.sh --file docs/x.md --from 'A' --to 'B' \
#       --test test/a.test.js --test test/b.test.js
#
# Exit codes: 0 = probe behaved as the mode predicts; 1 = it did not;
# 2 = precondition failed (file/sentence/test missing, clone failed).
#
# The probe never touches the working tree: it clones the repository into a
# temporary directory with `git clone <root> <tmp>` (one local object store,
# no network), edits the clone, and deletes it on exit.
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODE=probe
FILE=docs/work-packages/availability.md
FROM='Status: in progress.'
TO='Status: delivered.'
TESTS=()
LABEL=''

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --control) MODE=control; shift ;;
    --file) FILE=$2; shift 2 ;;
    --from) FROM=$2; shift 2 ;;
    --to) TO=$2; shift 2 ;;
    --test) TESTS+=("$2"); shift 2 ;;
    --label) LABEL=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "doc-claim-probe: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = control ] && [ ${#TESTS[@]} -eq 0 ]; then
  # The control is the edit #26 closed: a pinned host row moved off its recorded
  # glibc number. Before 7f3a20a the gate stayed green on it; now it must fail.
  FILE=docs/compatibility.md
  FROM='Debian 12 (2.36)'
  TO='Debian 12 (2.40)'
fi
if [ ${#TESTS[@]} -eq 0 ]; then
  # The default gate has to contain the test that reads the default sentence:
  # `docs-diagnostics.test.js` is what rejects the availability page claiming a
  # state its records do not support, so a list without it reports the page as
  # unbound no matter what the page says.
  TESTS=(test/release-platform-baseline.test.js
         test/release-compatibility-table.test.js
         test/release-records.test.js
         test/public-source-transition.test.js
         test/docs-links.test.js
         test/docs-diagnostics.test.js)
fi

[ -f "$ROOT/$FILE" ] || { echo "doc-claim-probe: no such file: $FILE" >&2; exit 2; }
command -v node >/dev/null || { echo "doc-claim-probe: node not on PATH" >&2; exit 2; }
for t in "${TESTS[@]}"; do
  [ -f "$ROOT/$t" ] || { echo "doc-claim-probe: no such test: $t" >&2; exit 2; }
done

grep -qF -- "$FROM" "$ROOT/$FILE" || {
  echo "doc-claim-probe: the sentence is gone from $FILE:" >&2
  echo "  expected to find: $FROM" >&2
  echo "  If it was reworded, pass --from with the current sentence." >&2
  exit 2
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/doc-claim-probe.XXXXXX") || exit 2
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

echo "doc-claim-probe"
echo "  repository : $ROOT"
echo "  mode       : $MODE"
echo "  file       : $FILE"
echo "  edit       : \"$FROM\"  ->  \"$TO\""
echo "  gate       : ${TESTS[*]}"
[ -n "$LABEL" ] && echo "  label      : $LABEL"
echo

if ! git clone --quiet --no-hardlinks --depth 1 "file://$ROOT" "$TMP/clone" 2>"$TMP/clone.err"; then
  cat "$TMP/clone.err" >&2
  echo "doc-claim-probe: could not clone the repository (uncommitted changes are not probed)" >&2
  exit 2
fi
CLONE="$TMP/clone"

python3 - "$CLONE/$FILE" "$FROM" "$TO" <<'PY' || { echo "doc-claim-probe: edit failed" >&2; exit 2; }
import sys
path, old, new = sys.argv[1:4]
text = open(path, encoding="utf-8").read()
if old not in text:
    sys.exit(1)
open(path, "w", encoding="utf-8").write(text.replace(old, new, 1))
PY

CHANGED=$(cd "$CLONE" && git diff --numstat -- "$FILE" | awk '{print $1"+"$2"-"}')
echo "  applied    : $CHANGED to $FILE in the clone"
echo

set +e
( cd "$CLONE" && node --test "${TESTS[@]}" ) >"$TMP/gate.log" 2>&1
GATE=$?
set -e

SUMMARY=$(grep -oE 'ℹ (tests|pass|fail) [0-9]+' "$TMP/gate.log" | tr '\n' ' ')
[ -z "$SUMMARY" ] && SUMMARY=$(tail -3 "$TMP/gate.log" | tr '\n' ' ')

echo "  gate exit  : $GATE"
echo "  totals     : $SUMMARY"
echo

if [ "$MODE" = probe ]; then
  if [ "$GATE" -eq 0 ]; then
    cat <<'EOF'
RESULT: the sentence is NOT bound to the gate.

The edit landed in the clone and every listed test still passed, so nothing in
the repository reads that sentence and notices it is now false. A reader cannot
tell from a green build whether the page means what it says.

This is the failure mode the probe exists to show. The fix is not a new prose
sentence: it is an assertion that fails on this edit. Record it as an issue with
this command, the file, and the edit, and the gate above as evidence.
EOF
    exit 0
  fi
  echo "RESULT: the sentence IS bound to the gate."
  echo "The edit made a listed test fail, which is the behaviour this probe hunts for."
  echo "The page is not a candidate; pick another sentence with --from/--to."
  exit 1
fi

if [ "$GATE" -ne 0 ]; then
  cat <<'EOF'
RESULT: control behaved as expected — the gate rejects the edit.

This control is the edit issue #26 closed: a pinned host row moved off its
recorded glibc number. The gate now rejects it, which is what makes the probe's
probe mode meaningful: if the control were green, every "not bound" result above
would be worthless, because the gate itself would be asleep.
EOF
  exit 0
fi
echo "RESULT: control FAILED — the gate accepted an edit it is supposed to reject."
echo "Fix the gate before trusting any probe-mode result."
exit 1
