import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// The fallback exists so that an unexpected error never prints a path, and it
// is the only name the gate has for an error it did not classify. It was
// chosen by shape rather than by membership: any message that happened to be
// one lowercase word passed through as though it were a refusal name, so a
// thrown `eperm` or `timeout` reached the operator looking exactly like a code
// the gate documents. A word the gate did not itself publish is not a name for
// anything, and it has to keep the fallback instead.

const MODES = ['--check', '--write', '--refresh']

// The builder resolves its root from its own location and imports its
// selection module from there, so a fixture root is a tree the shipped scripts
// run against without touching the repository's own list or manifest.
async function brokenRoot(body) {
  const root = await temporaryRoot('nothing-is-missing')
  await appendFile(join(root, 'scripts/source-import-selection.mjs'), `\n${body}\n`)
  return root
}

test('a thrown word is not a refusal name', async () => {
  for (const word of ['eperm', 'timeout', 'denied', 'enospc']) {
    const root = await brokenRoot(`throw new Error('${word}')`)
    for (const mode of MODES) {
      const result = await run(root, mode)
      assert.equal(result.status, 1, `${mode} must refuse a module that throws`)
      assert.equal(result.stdout, '', `${mode} must not write a receipt for it`)
      assert.equal(
        result.stderr,
        'source-import-failed\n',
        `${mode} must not pass ${JSON.stringify(word)} off as a code it published`,
      )
    }
  }
})

test('a word the gate publishes still reaches the operator', async () => {
  // The fallback must stay a fallback: narrowing what counts as a name would
  // re-break every refusal that already had one, so a code the gate itself
  // raises has to survive the same path the foreign words do not.
  const root = await brokenRoot("throw new Error('source-import-selection-invalid')")
  const result = await run(root, '--check')
  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-selection-invalid\n')
})

test('a path in the message never reaches the operator', async () => {
  const secret = ['', 'Users', 'someone', 'private', 'secret.txt'].join('/')
  const root = await brokenRoot(`throw new Error('${secret}')`)
  for (const mode of MODES) {
    const result = await run(root, mode)
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'source-import-failed\n')
    assert.doesNotMatch(result.stderr, /\//u, 'the refusal must not carry a path')
  }
})

test('the guide names the fallback it emits', async () => {
  const guide = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')
  // Every other code the gate prints is in the guide; the fallback was the one
  // name an operator could meet without anywhere to read what it means.
  assert.match(guide, /`source-import-failed`/u, 'the guide must name the fallback')
  assert.match(
    guide,
    /keeps the fallback unless/u,
    'the guide must say why a thrown word keeps the fallback',
  )
})
