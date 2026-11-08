import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

function read(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8')
}

const gate = read('docs/stable-release-gate.md')
const policy = read('docs/release-policy.md')

test('the stable release gate measures its own snapshot instead of freezing one', () => {
  assert.doesNotMatch(gate, /ca268c4/u)
  assert.match(gate, /`docs\/release-policy\.md`/u)
  assert.match(gate, /`revia project-check`/u)
  assert.match(gate, /`revia project-surface-check`/u)
  assert.match(gate, /`cargo test --workspace`/u)
  assert.match(gate, /does not extend to later commits/u)
  assert.match(gate, /证据只覆盖该 commit/u)
  assert.doesNotMatch(policy, /project-surface-check workflow/u)
  assert.match(policy, /does not extend to later\s+commits/u)
})

test('the gate names checks the shipped workflows actually run', () => {
  for (const workflow of [
    '.github/workflows/validate.yml',
    '.github/workflows/linux-native.yml',
    '.github/workflows/windows-native.yml',
  ]) {
    assert.match(read(workflow), /cargo test --workspace/u, workflow)
  }
  const windows = read('.github/workflows/windows-native.yml')
  assert.match(windows, /digest mismatch/u)
  const tests = read('native/revia-cli/tests/project_template.rs')
  assert.match(tests, /project-check/u)
  assert.match(tests, /project-surface-check/u)
})

test('the release policy names one commit for the code-validation snapshot', () => {
  const english = policy.match(
    /code-validation snapshot recorded in this policy is public main commit\s+`([0-9a-f]{7,40})`/u,
  )
  const chinese = policy.match(
    /本策略记录的代码验证快照为公开 main commit `([0-9a-f]{7,40})`/u,
  )
  assert.ok(english, 'release policy must name the English snapshot commit')
  assert.ok(chinese, 'release policy must name the Chinese snapshot commit')
  assert.equal(english[1], chinese[1])
  assert.equal(gate.includes(english[1]), false)
})
