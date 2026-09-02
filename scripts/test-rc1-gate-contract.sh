#!/bin/sh
set -eu

workflow=.github/workflows/rc1-release-gate.yml

! grep -Fq 'runtime/rc1/*.json' "$workflow"
grep -Fq 'for report in export-manifest candidate-manifest target-matrix native-evidence' "$workflow"
grep -Fq 'capability-evidence multi-module-evidence server-evidence; do' "$workflow"
grep -Fq 'cp "runtime/rc1/$report.json" "sealed/$report.json"' "$workflow"

grep -Fq "version=\$(sed -n '1p' VERSION)" .github/workflows/release-smoke.yml
grep -Fq "pending target" .github/workflows/release-smoke.yml
