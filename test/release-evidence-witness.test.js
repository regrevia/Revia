import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { classifyEvidenceWitness } from '../src/toolchain/release-evidence-witness.js'

const repository = new URL('../', import.meta.url)

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, repository), 'utf8'))
}

const evidence = {
  'linux-x64': await readJson('runtime/rc2.2.1/linux-native-evidence.json'),
  'windows-x64': await readJson('runtime/rc2.2.1/windows-native-evidence.json'),
}

const ZERO = 'sha256:' + '0'.repeat(64)

function measured(witness) {
  return { schema: 'revia.public-native-evidence@1.0.0', status: 'measured-native', target: 'linux-x64', witness }
}

const complete = {
  command: 'cargo build --workspace --release --offline',
  environment_digest: ZERO,
  raw_log_sha256: ZERO,
}

test('the shipped native evidence records are outcome-only, and say what is missing', () => {
  // The gate must not pass by construction: the records this release ships
  // carry no witness, so a reader cannot re-run the observation behind them.
  for (const [target, record] of Object.entries(evidence)) {
    assert.deepEqual(classifyEvidenceWitness(record), { missing: ['witness'], reDerivable: false }, target)
  }
})

test('a record with a stated witness is re-derivable, so the gate can pass', () => {
  assert.deepEqual(classifyEvidenceWitness(measured(complete)), { missing: [], reDerivable: true })
})

test('a partial witness names every absent field instead of passing', () => {
  const result = classifyEvidenceWitness(measured({ command: 'cargo build --release' }))
  assert.equal(result.reDerivable, false)
  assert.deepEqual(result.missing, ['witness.environment_digest', 'witness.raw_log_sha256'])
})

test('a witness with a malformed digest is not re-derivable', () => {
  const result = classifyEvidenceWitness(measured({ ...complete, environment_digest: 'sha256:not-a-digest' }))
  assert.equal(result.reDerivable, false)
  assert.deepEqual(result.missing, ['witness.environment_digest'])
})

test('a witness whose command is blank is not re-derivable', () => {
  const result = classifyEvidenceWitness(measured({ ...complete, command: '   ' }))
  assert.equal(result.reDerivable, false)
  assert.deepEqual(result.missing, ['witness.command'])
})

test('the witness requirement is scoped to measured-native records', () => {
  assert.deepEqual(
    classifyEvidenceWitness({ ...measured(complete), status: 'pending', witness: undefined }),
    { missing: [], reDerivable: false },
  )
})

test('the compatibility page says an outcome record cannot support a requires sentence', async () => {
  const page = await readFile(new URL('docs/compatibility.md', repository), 'utf8')
  assert.match(page, /a record without a `witness` cannot support a `requires` sentence/u)
  assert.match(page, /没有 `witness` 的记录不能支撑 `requires` 这类句子/u)
})

test('a record that carries a witness must be complete, so a partial one cannot ship', () => {
  // The shipped records are outcome-only, which the first test pins. This gate
  // is what a future record meets the moment it claims a witness: it cannot be
  // added half-done and stay green.
  for (const [target, record] of Object.entries(evidence)) {
    const { missing, reDerivable } = classifyEvidenceWitness({ ...record, witness: complete })
    assert.equal(reDerivable, true, `${target} with a complete witness must pass`)
    assert.deepEqual(missing, [])
    const partial = classifyEvidenceWitness({ ...record, witness: { command: record.scope } })
    assert.equal(partial.reDerivable, false, `${target} with a partial witness must fail`)
    assert.deepEqual(partial.missing, ['witness.environment_digest', 'witness.raw_log_sha256'])
  }
})
