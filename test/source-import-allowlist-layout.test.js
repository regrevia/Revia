import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { renderAllowlist } from '../scripts/source-import-selection.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

const committed = async () => readFile(join(ROOT, 'SOURCE_IMPORT_FILES.json'), 'utf8')

// The allowlist is reviewed as a diff, and a diff only carries the change when
// the file keeps one path per line. `--refresh` used to render the whole list on
// a single line, so admitting one file rewrote all 707 other lines with it and
// the admission itself was buried.
test('the allowlist a refresh would write is the allowlist the repository keeps', async () => {
  const expected = await committed()
  const { files } = JSON.parse(expected)
  assert.equal(renderAllowlist(files), expected)
})

// A layout that does not change with the content would pass the check above
// while still collapsing every edit onto one line, so the second half is that
// one admitted path costs exactly one line.
test('admitting one path adds one line and leaves the others untouched', () => {
  const before = renderAllowlist(['alpha.txt', 'gamma.txt']).split('\n')
  const after = renderAllowlist(['alpha.txt', 'beta.txt', 'gamma.txt']).split('\n')
  assert.equal(after.length, before.length + 1)
  assert.deepEqual(after.filter((line) => !before.includes(line)), ['    "beta.txt",'])
})

// The layout above only reaches the file when the builder renders through it.
test('the refresh renders the allowlist through the shared function', async () => {
  const builder = await readFile(join(ROOT, 'scripts/build-source-import-manifest.js'), 'utf8')
  assert.match(builder, /renderAllowlist\(files\)/u)
  assert.doesNotMatch(builder, /writeFile\(ALLOWLIST, `\$\{canonicalJson\(\{/u)
})

test('the contributor guide says what a refresh diff should look like', async () => {
  const guide = await readFile(join(ROOT, 'AGENTS.md'), 'utf8')
  assert.match(guide, /`--refresh` rewrites the allowlist one path per line/u)
})
