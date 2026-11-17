import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// A refusal is a claim the mode could not make good, but it is not the absence
// of a decision: --refresh computes the allowlist transition before it writes,
// and the write is the only thing that fails. Dropping the value at the refusal
// left every success machine-readable and every failure a bare exit code, so a
// caller could learn what was refused and never what the mode had reached.
const REFUSAL_SCHEMA = 'revia.source-import-refusal@1.0.0'

test('a refresh that cannot write the allowlist still reports the transition it reached', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  await rm(join(root, 'SOURCE_IMPORT_FILES.json'))
  await mkdir(join(root, 'SOURCE_IMPORT_FILES.json'))

  const result = await run(root, '--refresh')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-allowlist-unwritable\n')
  assert.deepEqual(JSON.parse(result.stdout), {
    allowlist_transition: 'created',
    reason: 'source-import-allowlist-unwritable',
    schema: REFUSAL_SCHEMA,
  })
})

// The manifest refusal reaches both, and it is still the allowlist transition
// that the receipt carries: --write never writes the list, so the field says
// what that mode did rather than what another mode would have done.
test('a write that cannot land the manifest reports the same shape', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  await rm(join(root, 'SOURCE_IMPORT_MANIFEST.json'))
  await mkdir(join(root, 'SOURCE_IMPORT_MANIFEST.json'))

  const result = await run(root, '--write')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-manifest-unwritable\n')
  assert.deepEqual(JSON.parse(result.stdout), {
    allowlist_transition: 'unchanged',
    reason: 'source-import-manifest-unwritable',
    schema: REFUSAL_SCHEMA,
  })
})

// A refusal that never reached a decision invents nothing: the tree was never
// read that far, so there is no transition to report and stdout stays empty.
// This is the line the receipt must not cross, because a fabricated
// `unchanged` would be indistinguishable from a mode that looked and agreed.
test('a refusal that never reached a decision reports no transition', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  const path = join(root, 'SOURCE_IMPORT_FILES.json')
  const { readFile } = await import('node:fs/promises')
  await writeFile(path, `\uFEFF${await readFile(path, 'utf8')}`)

  const result = await run(root, '--refresh')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'byte-order-mark-not-allowed\n')
  assert.equal(result.stdout, '')
})

// A refusal an operator only learns about by running the gate twice is a claim
// with nothing behind it, so the guide is read here rather than trusted: the
// schema, the field, and the line the receipt must not cross have to be on the
// page an operator is sent to.
test('the guide states the receipt a refusal carries and the line it stops at', async () => {
  const { readFile } = await import('node:fs/promises')
  const guide = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')
  const clause = guide.split('\n').join(' ').replace(/\s+/gu, ' ')
  assert.match(clause, /reports the transition it reached on stdout/u)
  assert.match(clause, /`revia\.source-import-refusal@1\.0\.0` carrying `allowlist_transition`/u)
  assert.match(clause, /a refusal that never reached a decision prints nothing/iu)
})
