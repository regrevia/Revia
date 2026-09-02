#!/bin/sh
set -eu

workflow=.github/workflows/rc1-release-gate.yml

! grep -Fq 'runtime/rc1/*.json' "$workflow"
for report in export-manifest candidate-manifest target-matrix native-evidence capability-evidence multi-module-evidence server-evidence; do
  grep -Fq "runtime/rc1/$report.json" "$workflow"
done
