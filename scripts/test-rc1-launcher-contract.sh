#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

grep -Fq 'Only darwin-arm64 is measured for this RC.' bin/revia
grep -Fq 'Darwin:arm64)' bin/revia
grep -Fq 'Revia 1.0.0-rc.1 is an evaluation candidate' bin/revia
grep -Fq "if (\$Version -eq '1.0.0-rc.1')" bin/revia.ps1
grep -Fq 'Only darwin-arm64 is measured for this RC.' bin/revia.ps1

printf '%s\n' 'RC1 launcher contract passed'
