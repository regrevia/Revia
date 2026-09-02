#!/bin/sh
set -eu

tree=scripts/validate-public-tree.sh
workflow=.github/workflows/validate.yml

grep -Fq '0.1-preview.1)' "$tree"
grep -Fq '1.0.0-rc.1)' "$tree"
grep -Fq 'revia-1.0.0-rc.1-darwin-arm64.tar.gz' "$tree"
for target in darwin-x64 linux-arm64 linux-x64 windows-arm64 windows-x64; do
  grep -Fq "$target" "$tree"
done
grep -Fq 'pending-target' "$workflow"
! grep -Fq 'hashFiles' "$workflow"
grep -Fq 'unexpected preview run output' "$workflow"
