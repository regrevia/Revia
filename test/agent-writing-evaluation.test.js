import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { RELEASE_TOOLCHAIN_PATHS } from '../src/runtime/release-toolchain-inventory.js'
import { digestTrackedFiles } from '../src/runtime/release-evidence.js'
import {
  runAgentWritingEvaluation,
  verifyAgentWritingEvaluation,
} from '../src/toolchain/agent-writing-evaluation.js'

const root = new URL('../', import.meta.url)
const readJson = async (path) => JSON.parse(await readFile(
  new URL(path, root),
  'utf8',
))
const digestBytes = (value) => `sha256:${createHash('sha256')
  .update(value)
  .digest('hex')}`

test('fixed agent writing corpus replays success and attack cases without API keys', async () => {
  const corpus = await readJson('test/fixtures/agent-writing-evaluation-corpus.json')
  const project = await readJson('test/fixtures/agent-writing-evaluation-project.json')
  const sourcePaths = [
    'src/toolchain/agent-authoring-loop.js',
    'src/toolchain/fact-ledger.js',
    'src/toolchain/human-semantic-review.js',
    'src/toolchain/project-patch.js',
    'src/toolchain/project-review-index.js',
  ]
  const sourceAuthority = Object.fromEntries(await Promise.all(
    sourcePaths.map(async (path) => [
      path,
      digestBytes(await readFile(new URL(path, root))),
    ]),
  ))
  const inputs = {
    corpus,
    project,
    source_authority: sourceAuthority,
    toolchain_digest: digestTrackedFiles(await Promise.all(
      RELEASE_TOOLCHAIN_PATHS.map(async (path) => ({
        bytes: await readFile(new URL(path, root)),
        path,
      })),
    )),
  }
  const report = await runAgentWritingEvaluation(inputs)
  assert.deepEqual(await verifyAgentWritingEvaluation(report, inputs), { ok: true })
  assert.equal(report.schema, 're.agent-writing-evaluation@0.1.0')
  assert.equal(report.status, 'pass')
  assert.equal(report.authority.api_keys_required, false)
  assert.equal(report.cases.length, 10)
  assert.deepEqual(report.cases.map(({ id }) => id), corpus.cases.map(({ id }) => id))
  assert.equal(report.cases.filter(({ status }) => status === 'pass').length, 10)
  assert.ok(report.cases.every(({ wrong_graph_count }) => wrong_graph_count === 0))
})
