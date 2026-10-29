#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

VERSION=$(sed -n '1p' VERSION)
test "$(shasum -a 256 LICENSE | awk '{print $1}')" = \
  '66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172'
test -f SOURCE-LICENSE.md
test -f LICENSE-PREVIEW-0.1.md
test -f LICENSE-RC.md
test -f NOTICE-RC.md
grep -Fq 'Mozilla Public License 2.0' SOURCE-LICENSE.md
grep -Fq 'MPL-2.0' package.json
grep -Fq 'MPL-2.0' native/Cargo.toml
grep -Fq 'regrevia/Revia' bin/revia
grep -Fq 'regrevia/Revia' bin/revia.ps1
sh -n bin/revia
sh -n scripts/verify-rc1-export.sh
sh -n scripts/verify-rc1-trial-kit.sh
sh -n scripts/run-public-trials.sh
sh -n scripts/run-reviewed-file-plan.sh
node scripts/build-source-import-manifest.js --check

if [ "$VERSION" = '1.0.0-rc.1' ]; then
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('runtime/rc1/export-manifest.json', 'utf8'))
const license = readFileSync('LICENSE-RC.md')
const notice = readFileSync('NOTICE-RC.md')
const files = new Map(manifest.files.map(({ path, sha256 }) => [path, sha256]))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

assert.equal(manifest.version, '1.0.0-rc.1')
assert.equal(manifest.tag, 'v1.0.0-rc.1')
assert.equal(files.get('LICENSE-RC.md'), sha256(license))
assert.equal(files.get('NOTICE-RC.md'), sha256(notice))
assert.equal(
  sha256(readFileSync('runtime/checksums.txt')),
  '598c836cc8838ab3cdbc66a36ee350aa05ed67d1c9e9cedbb5862751e716ab71',
)
NODE
elif [ "$VERSION" = '1.0.0-rc.2.1' ] || [ "$VERSION" = '1.0.0-rc.2.2' ]; then
RC_ROOT='runtime/rc2.1'
[ "$VERSION" = '1.0.0-rc.2.2' ] && RC_ROOT='runtime/rc2.2'
REVIA_RC_ROOT="$RC_ROOT" \
REVIA_EXPECTED_VERSION="$VERSION" \
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const root = process.env.REVIA_RC_ROOT || 'runtime/rc2.1'
const manifest = JSON.parse(readFileSync(`${root}/export-manifest.json`, 'utf8'))
const candidate = JSON.parse(readFileSync(`${root}/candidate-manifest.json`, 'utf8'))
const matrix = JSON.parse(readFileSync(`${root}/target-matrix.json`, 'utf8'))
const checksums = readFileSync('runtime/checksums.txt', 'utf8')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

assert.equal(manifest.version, process.env.REVIA_EXPECTED_VERSION || '1.0.0-rc.2.1')
assert.equal(manifest.tag, `v${manifest.version}`)
assert.equal(candidate.version, manifest.version)
assert.equal(candidate.status, 'measured-native')
assert.equal(matrix.version, manifest.version)
if (manifest.version === '1.0.0-rc.2.1') {
  assert.equal(manifest.target, 'windows-x64')
  assert.equal(matrix.targets.find(({ target }) => target === 'windows-x64').status, 'measured-native')
  assert.match(checksums, new RegExp(`^[0-9a-f]{64}  revia-${manifest.version}-windows-x64\\.zip$`, 'm'))
  assert.match(checksums, new RegExp(`^[0-9a-f]{64}  revia-${manifest.version}-windows-x64$`, 'm'))
} else {
  assert.deepEqual(manifest.targets.sort(), ['linux-x64', 'windows-x64'])
  assert.equal(matrix.targets.find(({ target }) => target === 'linux-x64').status, 'measured-native')
  assert.equal(matrix.targets.find(({ target }) => target === 'windows-x64').status, 'measured-native')
  assert.match(checksums, new RegExp(`^[0-9a-f]{64}  revia-${manifest.version}-linux-x64\\.tar\\.gz$`, 'm'))
  assert.match(checksums, new RegExp(`^[0-9a-f]{64}  revia-${manifest.version}-linux-x64$`, 'm'))
  assert.match(checksums, new RegExp(`^[0-9a-f]{64}  revia-${manifest.version}-windows-x64\\.zip$`, 'm'))
  assert.match(checksums, new RegExp(`^[0-9a-f]{64}  revia-${manifest.version}-windows-x64$`, 'm'))
}
assert.equal(
  manifest.files.find(({ path }) => path === 'LICENSE-RC.md').sha256,
  `sha256:${sha256(readFileSync('LICENSE-RC.md'))}`,
)
assert.equal(
  manifest.files.find(({ path }) => path === 'NOTICE-RC.md').sha256,
  `sha256:${sha256(readFileSync('NOTICE-RC.md'))}`,
)
NODE
else
  printf '%s\n' "unsupported VERSION: $VERSION" >&2
  exit 65
fi

git diff --check
