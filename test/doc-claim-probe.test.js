import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'doc-claim-probe.sh')

const script = async () => readFile(SCRIPT, 'utf8')

const controlBlock = (source) => {
  const match = /if \[ "\$MODE" = control \] && \[ \$\{#TESTS\[@\]\} -eq 0 \]; then([\s\S]*?)\nfi/u.exec(
    source,
  )
  assert.ok(match !== null, 'the script must keep a control block that runs by default')
  return match[1]
}

const defaultGate = (source) => {
  const match = /TESTS=\((test\/[^)]*)\)/u.exec(source)
  assert.ok(match !== null, 'the script must name the tests it runs as a default gate')
  return match[1].split(/\s+/u).filter(Boolean)
}

// The probe edits a sentence and reports whether a test noticed. That answer is
// only worth reading while the sentence it edits is still on the page: a
// reworded anchor makes the script exit 2, and an anchor that quietly moved to
// a different sentence would report "not bound" about text no gate was ever
// meant to read.
test('the sentence the probe edits by default is the sentence the page carries', async () => {
  const source = await script()
  const from = /^FROM='([^']+)'$/mu.exec(source)
  const file = /^FILE=(.+)$/mu.exec(source)
  assert.ok(from !== null && file !== null, 'the default anchor must be a literal')
  const page = await readFile(join(ROOT, file[1]), 'utf8')
  assert.ok(
    page.includes(from[1]),
    `the probe edits "${from[1]}", which ${file[1]} no longer carries`,
  )
})

// The control is the half that makes the probe falsifiable: if the gate it
// edits were green, every "not bound" result would be a report about a sleeping
// gate. The row it moves is the one issue #26 closed, so it must stay on the
// recorded glibc number rather than on one the baseline does not pin.
test('the control edits a row the compatibility baseline pins', async () => {
  const block = controlBlock(await script())
  const from = /FILE=([^\n]+)/u.exec(block)
  const sentence = /FROM='([^']+)'/u.exec(block)
  assert.ok(from !== null && sentence !== null, 'the control must name a file and a sentence')
  const page = await readFile(join(ROOT, from[1]), 'utf8')
  assert.ok(
    page.includes(sentence[1]),
    `the control edits "${sentence[1]}", which ${from[1]} no longer carries`,
  )
  assert.match(
    sentence[1],
    /\(\d+\.\d+\)$/u,
    'the control must move a glibc version, which is what the baseline pins',
  )
})

// The default gate has to contain the test that reads the default sentence, or
// the probe reports the page as unbound no matter what the page says. That is
// the bug this file was written after: the gate list was missing
// docs-diagnostics.test.js, so a sentence the diagnostics test rejects was
// reported as read by nothing.
test('the default gate carries the test that binds the default sentence', async () => {
  const gate = defaultGate(await script())
  assert.ok(
    gate.includes('test/docs-diagnostics.test.js'),
    'the test that rejects the availability page claiming an unsupported state must be in the gate',
  )
  for (const path of gate) {
    await access(join(ROOT, path))
  }
})

// A shell script nothing parses can be published in a broken state and only fail
// when a reader runs it, which is the failure mode a syntax check removes.
test('bash parses the probe', () => {
  const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
