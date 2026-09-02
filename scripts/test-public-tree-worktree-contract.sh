#!/bin/sh
set -eu

scanner=scripts/validate-public-tree.sh
grep -Fq -- '--exclude=.git' "$scanner"
