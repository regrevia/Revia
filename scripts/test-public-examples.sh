#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

test -f examples/agent-evidence-boundary.re
grep -Fq 'agent-evidence-boundary' examples/README.md
./bin/revia check examples/agent-evidence-boundary.re
test "$(./bin/revia run examples/agent-evidence-boundary.re)" = 'case=evidence-boundary
next=compare-manifest'
./bin/revia manifest examples/agent-evidence-boundary.re | grep -Fq 'graph_revision'
./bin/revia view --locale en-US --format html examples/agent-evidence-boundary.re | grep -Fq 'capability:@stdout'
