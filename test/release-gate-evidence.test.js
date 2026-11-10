import assert from 'node:assert/strict'
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

function read(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8')
}

const gate = read('docs/stable-release-gate.md')
const notes = read('RELEASE_NOTES.md')
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

test('the release notes describe the later snapshot the same way', () => {
  assert.doesNotMatch(notes, /current main source/u)
  assert.doesNotMatch(notes, /当前 main 源码/u)
  assert.doesNotMatch(notes, /project-surface-check gate/u)
  assert.match(notes, /`ca268c4`/u)
  assert.match(notes, /`docs\/release-policy\.md`/u)
  assert.match(notes, /`cargo test --workspace`/u)
  assert.match(notes, /re-verified the digest of the\s+executable/u)
  assert.match(notes, /核对自己构建的\s*可执行文件摘要/u)
})

// A workflow that invokes a renamed or deleted file fails only when that gate
// is triggered, which for the release workflows can be the worst possible
// moment. The paths are checked in the tree instead, so a rename has to be
// carried into every workflow that names it.
const WORKFLOW_PATH =
  /\b((?:scripts|test|runtime|bin|native|experiments|examples|docs)\/[A-Za-z0-9_./-]+\.(?:sh|mjs|js|json|ps1|rs|toml|yml|md))(?![\w-])/gu

test('every file the workflows invoke exists in the tree', () => {
  const directory = join(repositoryRoot, '.github/workflows')
  const workflows = readdirSync(directory).filter((name) => name.endsWith('.yml'))
  assert.ok(workflows.length >= 7, `expected the workflows, found ${workflows.length}`)
  const referenced = new Set()
  for (const workflow of workflows) {
    for (const match of read(join('.github/workflows', workflow)).matchAll(WORKFLOW_PATH)) {
      referenced.add(match[1])
    }
  }
  assert.ok(
    referenced.size >= 8,
    `expected the workflow references, found ${referenced.size}`,
  )
  const missing = [...referenced]
    .filter((relativePath) => !existsSync(join(repositoryRoot, relativePath)))
    .sort()
  assert.deepEqual(missing, [], 'every path a workflow invokes exists')
})

// A workflow that omits `permissions` inherits the repository default for the
// token, so a gate can quietly gain write access it never needed. The block is
// read from the workflows themselves and only `{}` or read-only scopes pass.
test('every workflow narrows the token permissions it runs with', () => {
  const directory = join(repositoryRoot, '.github/workflows')
  const workflows = readdirSync(directory).filter((name) => name.endsWith('.yml'))
  assert.ok(workflows.length >= 7, `expected the workflows, found ${workflows.length}`)
  const broad = []
  for (const workflow of workflows) {
    const lines = read(join('.github/workflows', workflow)).split('\n')
    const start = lines.findIndex((line) => /^permissions:/u.test(line))
    if (start === -1) {
      broad.push(`${workflow}: no permissions block`)
      continue
    }
    if (/^permissions: \{\}$/u.test(lines[start])) continue
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '' || line.startsWith('  ')) {
        const scope = /^\s+([a-z-]+):\s*(\S+)\s*$/u.exec(line)
        if (scope !== null && !/^(?:read|none)$/u.test(scope[2])) {
          broad.push(`${workflow}: ${scope[1]} ${scope[2]}`)
        }
        continue
      }
      break
    }
  }
  assert.deepEqual(broad, [], 'every workflow blocks with read-only or no permissions')
})
