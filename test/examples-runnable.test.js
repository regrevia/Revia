import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// examples/README.md is a first-run document: it says to run commands from the
// repository root and lists which examples answer which question. Every `.re`
// file there is either runnable as documented or a design fixture that the
// toolchain rejects on purpose, so this test runs each one and pins the exact
// classification. A new example that is not added to one of the tables below
// fails here instead of reaching a reader as a silent wrong exit code.

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const examples = join(repositoryRoot, 'examples')
const cli = join(repositoryRoot, 'src', 'cli', 're.js')

// Runnable programs that print one deterministic report on stdout.
const PRINTING = new Map([
  ['agent-business-starter.re', 'decision=review\n'],
  [
    'agent-counterexample.re',
    'claim=green-gate-proves-success\ncounterexample=empty-population\n' +
      'expected=gate-rejects\nnext=submit-minimal-fixture\n',
  ],
  ['agent-evidence-boundary.re', 'case=evidence-boundary\nnext=compare-manifest\n'],
  [
    'agent-release-check.re',
    'release=review\nasset=present\nevidence=measured\nstable=blocked\n' +
      'next=verify-all-targets\n',
  ],
  [
    'agent-review-packet.re',
    'task=review-packet\nobserved=bounded-preview\n' +
      'risk=unverified-assumption\nnext=run-counterexample\n',
  ],
  [
    'agent-workflow-brief.re',
    'task=review\nstate=ready\nrisk=visible\nnext=inspect-manifest\n',
  ],
  ['hello.re', 'Hello, World!\n'],
])

// Runnable programs whose outcome is an exit status rather than output.
const SILENT = [
  'agent-args-policy.re',
  'agent-file-report.re',
  'args-check.re',
  'read-check.re',
  'read-encoding.re',
  'write-check.re',
]

// The argument-name diagnostic: the Node check reports it, and running the
// program reports the same thing because the same validation runs first.
const DIAGNOSTIC = 'diagnostic-error.re'

// Design fixtures: both toolchains reject them with an unexpected-token
// diagnostic, so they must never be presented as first-run examples.
const REJECTED = [
  'cf-branch.re',
  'cf-concurrent.re',
  'cf-loop.re',
  'cf-retry.re',
  'p0-demo-runtime.re',
  'schema-ops.re',
]

function runCli(cwd, ...arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd,
    encoding: 'utf8',
  })
}

async function copyExamples(destination) {
  for (const name of await readdir(examples)) {
    if (name.endsWith('.re') || name.endsWith('.txt')) {
      await cp(join(examples, name), join(destination, name))
    }
  }
}

test('every example runs as examples/README.md classifies it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revia-examples-'))
  try {
    await copyExamples(directory)
    const names = (await readdir(directory)).filter((name) => name.endsWith('.re')).sort()
    assert.deepEqual(
      names,
      [...PRINTING.keys(), ...SILENT, DIAGNOSTIC, ...REJECTED].sort(),
      'every example must be classified in this test',
    )

    for (const name of [...PRINTING.keys(), ...SILENT]) {
      const result = runCli(repositoryRoot, 'run', join(directory, name))
      assert.equal(result.status, 0, `${name} must run: ${result.stderr}`)
      assert.equal(result.stdout, PRINTING.get(name) ?? '', `${name} output`)
      assert.equal(result.stderr, '', `${name} stderr`)
    }

    const diagnostic = runCli(repositoryRoot, 'run', join(directory, DIAGNOSTIC))
    assert.equal(diagnostic.status, 65)
    assert.equal(diagnostic.stdout, '')
    assert.match(diagnostic.stderr, /:9:28: unexpected-argument \(expected data, got message\)/u)

    for (const name of REJECTED) {
      const result = runCli(repositoryRoot, 'run', join(directory, name))
      assert.equal(result.status, 65, `${name} must be rejected`)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /unexpected-token/u)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the reading examples need the input file beside them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revia-examples-input-'))
  try {
    for (const name of ['read-check.re', 'read-encoding.re']) {
      await copyExamples(directory)
      const withInput = runCli(repositoryRoot, 'run', join(directory, name))
      assert.equal(withInput.status, 0, `${name} reads input.txt`)

      await unlink(join(directory, 'input.txt'))
      const withoutInput = runCli(repositoryRoot, 'run', join(directory, name))
      assert.equal(withoutInput.status, 2, `${name} takes its err branch`)
      assert.equal(withoutInput.stdout, '')
      assert.equal(
        withoutInput.stderr,
        '',
        'a missing file is the program err branch, not a toolchain diagnostic',
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the examples README names the input file it ships', async () => {
  const readme = await readFile(join(examples, 'README.md'), 'utf8')
  assert.match(readme, /`input\.txt` beside the program/u)
  assert.match(readme, /程序文件旁边的\s*`input\.txt`/u)

  const input = await readFile(join(examples, 'input.txt'), 'utf8')
  assert.equal(input, 'example input for read-check.re\n')
})

test('the examples README names every example it ships', async () => {
  const readme = await readFile(join(examples, 'README.md'), 'utf8')
  const unnamed = []
  for (const entry of await readdir(examples, { withFileTypes: true })) {
    if (!entry.name.endsWith('.re') && !entry.isDirectory()) continue
    // A directory is named with the trailing slash the README links use.
    const linkedName = entry.isDirectory() ? `${entry.name}/` : entry.name
    if (!readme.includes(`](${linkedName})`)) unnamed.push(linkedName)
  }
  assert.deepEqual(unnamed, [], 'an example the README does not name is one a reader cannot find')
})

// A nested `.re` file is an example too, and the top-level tables above cannot
// see it. Each one is either a standalone program the checker accepts, or a
// module of a project fixture, which only the project checker can judge.
async function nestedPrograms(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await nestedPrograms(entryPath)))
    else if (entry.name.endsWith('.re') && entryPath !== join(examples, entry.name)) found.push(entryPath)
  }
  return found.sort()
}

async function hasProjectFile(directory) {
  try {
    await readFile(join(directory, 'project.json'))
    return true
  } catch {
    return false
  }
}

test('nested examples are accepted by the checker or by their project', async () => {
  const fixtures = new Set()
  for (const program of await nestedPrograms(examples)) {
    let directory = join(program, '..')
    while (directory.startsWith(examples) && directory !== examples && !(await hasProjectFile(directory))) {
      directory = join(directory, '..')
    }
    if (await hasProjectFile(directory)) fixtures.add(directory)
  }

  for (const fixture of [...fixtures].sort()) {
    const checked = spawnSync(process.execPath, [cli, 'project-check', '--format', 'json', fixture], {
      encoding: 'utf8'
    })
    assert.equal(checked.status, 0, `${fixture} does not pass project-check: ${checked.stderr}`)
  }

  const rejected = []
  for (const program of await nestedPrograms(examples)) {
    let insideFixture = false
    for (const fixture of fixtures) if (program.startsWith(`${fixture}/`)) insideFixture = true
    if (insideFixture) continue
    const checked = spawnSync(process.execPath, [cli, 'check', program], { encoding: 'utf8' })
    if (checked.status !== 0) rejected.push(`${program}: ${checked.stderr.trim().split('\n')[0]}`)
  }
  assert.deepEqual(rejected, [], 'a nested example the checker rejects is one a reader cannot run')
})
