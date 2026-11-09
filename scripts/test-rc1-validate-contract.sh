#!/bin/sh
# The tree validator chooses its release-record branch from VERSION, so a
# version bump that skips it would quietly stop validating the checked-in
# records. Keep the two files in step.
set -eu

tree=scripts/validate-public-tree.sh
workflow=.github/workflows/validate.yml

grep -Fq "1.0.0-rc.1')" "$tree"
grep -Fq 'unsupported VERSION' "$tree"
grep -Fq 'sh scripts/validate-public-tree.sh' "$workflow"

version=$(sed -n '1p' VERSION)
grep -Fq "'$version'" "$tree"
