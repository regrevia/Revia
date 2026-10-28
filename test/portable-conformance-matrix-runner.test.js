import assert from 'node:assert/strict'
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

let evidenceStore
try {
  evidenceStore = await import(
    '../scripts/portable-conformance-evidence-store.js'
  )
} catch {
  evidenceStore = null
}

test('portable conformance evidence commits only after verification succeeds', async () => {
  assert.notEqual(evidenceStore, null)

  const directory = await mkdtemp(join(tmpdir(), 'revia-matrix-store-'))
  const destination = join(directory, 'evidence.json')
  await writeFile(destination, 'old\n')
  const candidate = { schema: 'candidate' }

  const result = await evidenceStore.commitPortableConformanceEvidence({
    destination,
    evidence: candidate,
    verify: async (candidatePath) => {
      assert.notEqual(candidatePath, destination)
      assert.deepEqual(
        JSON.parse(await readFile(candidatePath, 'utf8')),
        candidate,
      )
    },
  })

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(
    JSON.parse(await readFile(destination, 'utf8')),
    candidate,
  )
  assert.deepEqual(await readdir(directory), ['evidence.json'])
})

test('portable conformance evidence preserves the previous file on failure', async () => {
  assert.notEqual(evidenceStore, null)

  const directory = await mkdtemp(join(tmpdir(), 'revia-matrix-store-'))
  const destination = join(directory, 'evidence.json')
  await writeFile(destination, 'old\n')

  await assert.rejects(
    evidenceStore.commitPortableConformanceEvidence({
      destination,
      evidence: { schema: 'candidate' },
      verify: async () => {
        throw new Error('tracked tests failed')
      },
    }),
    /tracked tests failed/u,
  )

  assert.equal(await readFile(destination, 'utf8'), 'old\n')
  assert.deepEqual(await readdir(directory), ['evidence.json'])
})
