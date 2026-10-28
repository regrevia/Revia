import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  runPublicAiNativeDemo,
  verifyPublicAiNativeDemo,
} from '../src/toolchain/public-ai-native-demo.js'

const root = new URL('../', import.meta.url)
const readJson = async (path) => JSON.parse(await readFile(
  new URL(path, root),
  'utf8',
))

test('public AI-native demo closes the expense approval path without API keys', async () => {
  const report = await runPublicAiNativeDemo({
    corpus: await readJson('test/fixtures/agent-writing-evaluation-corpus.json'),
    project: await readJson('test/fixtures/agent-writing-evaluation-project.json'),
    expense_project_path: 'examples/agent-expense-review',
    expense_run_fixture_path: 'examples/agent-expense-review-run.json',
    root: new URL('../', import.meta.url),
  })

  assert.deepEqual(await verifyPublicAiNativeDemo(report, {
    corpus: await readJson('test/fixtures/agent-writing-evaluation-corpus.json'),
    project: await readJson('test/fixtures/agent-writing-evaluation-project.json'),
    expense_project_path: 'examples/agent-expense-review',
    expense_run_fixture_path: 'examples/agent-expense-review-run.json',
    root: new URL('../', import.meta.url),
  }), { ok: true })
  assert.equal(report.schema, 're.public-ai-native-demo@0.1.0')
  assert.equal(report.authority.api_keys_required, false)
  assert.deepEqual(report.sequence, [
    'proposal',
    'dry-run',
    'semantic-diff-review',
    'approval',
    'apply',
    'check',
    'manifest',
    'run',
    'translate',
    'receipt',
    'human-semantic-review',
  ])
  assert.equal(report.success.status, 'pass')
  assert.equal(report.success.toolchain.check.status, 'passed')
  assert.equal(report.success.toolchain.manifest.status, 'passed')
  assert.equal(report.success.toolchain.run.status, 'passed')
  assert.equal(report.success.toolchain.translate.status, 'passed')
  assert.equal(report.success.human_semantic_review.status, 'passed')
  assert.equal(report.attacks.stale.status, 'rejected')
  assert.equal(report.attacks.stale.dangerous_modification_rejected, true)
  assert.equal(report.attacks.capability_overreach.status, 'rejected')
  assert.equal(report.attacks.capability_overreach.dangerous_modification_rejected, true)
  assert.equal(report.expense_project.status, 'passed')
  assert.equal(report.expense_project.module_count, 6)
  assert.ok(Number.isSafeInteger(report.command_duration_ms))
  assert.ok(report.command_duration_ms >= 0)
})
