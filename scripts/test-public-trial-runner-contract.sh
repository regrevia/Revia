#!/bin/sh
set -eu

runner=scripts/run-public-trials.sh
test -x "$runner"
sh -n "$runner"
grep -Fq '.trials[$trial].steps | length' "$runner"
grep -Fq '.steps[$step].command' "$runner"
grep -Fq '.expected.results' "$runner"
grep -Fq 'result differs from fixture' "$runner"
grep -Fq 'trial manifest step contract is invalid' "$runner"
