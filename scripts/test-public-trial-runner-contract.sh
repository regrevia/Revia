#!/bin/sh
set -eu

runner=scripts/run-public-trials.sh

test -x "$runner"
sh -n "$runner"
grep -Fq 'trial-manifest.json' "$runner"
grep -Fq 'expected.exit_status' "$runner"
grep -Fq 'expected.stdout_sha256' "$runner"
grep -Fq 'expected.stderr_sha256' "$runner"
grep -Fq 'expected.result_sha256' "$runner"
grep -Fq 'result_fixture' "$runner"
grep -Fq 'result_path' "$runner"
grep -Fq 'REVIA_EXECUTABLE' "$runner"
