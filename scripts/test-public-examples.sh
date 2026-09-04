#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

test -f examples/agent-evidence-boundary.re
grep -Fq 'agent-evidence-boundary' examples/README.md

test_example() {
  file=$1
  ./bin/revia check "$file"
  ./bin/revia digest "$file" | grep -Eq '^sha256:[0-9a-f]{64}$'
  ./bin/revia manifest "$file" | jq -e '
    .schema == "re.native-review-manifest@0.1.0" and
    (.graph_revision | test("^sha256:[0-9a-f]{64}$"))
  ' >/dev/null
  ./bin/revia translate "$file" | grep -Fq 're 0.1 bytecode'
}

test_example examples/agent-review-packet.re
test_example examples/agent-release-check.re
test_example examples/agent-counterexample.re

case "$(sed -n '1p' VERSION)" in
  1.0.0-rc.1)
    jq -e '.version == "1.0.0-rc.1" and (.trials | length == 7)' \
      experiments/rc1/kit/trial-manifest.json >/dev/null
    sh scripts/test-adversarial-review-contract.sh
    printf '%s\n' 'RC1 public trial-kit contract passed'
    exit 0
    ;;
esac
./bin/revia check examples/agent-evidence-boundary.re
test "$(./bin/revia run examples/agent-evidence-boundary.re)" = 'case=evidence-boundary
next=compare-manifest'
./bin/revia manifest examples/agent-evidence-boundary.re | grep -Fq 'graph_revision'
./bin/revia view --locale en-US --format html examples/agent-evidence-boundary.re | grep -Fq 'capability:@stdout'
sh scripts/test-adversarial-review-contract.sh
