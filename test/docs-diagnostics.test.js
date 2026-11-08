import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// docs/diagnostics.md tells a reader what a rejection looks like and which
// code it exits with. The page is only useful if every claim in it is the
// measured behaviour of the CLI, so this test reads the constants out of the
// CLI, runs the documented cases, and compares the page against both. It runs
// in a temporary directory and starts from a source example, so a fresh
// checkout without build output can run it.

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const cli = join(repositoryRoot, 'src', 'cli', 're.js')
const diagnostics = await readFile(
  join(repositoryRoot, 'docs', 'diagnostics.md'),
  'utf8',
)
const source = await readFile(join(repositoryRoot, 'src', 'cli', 're.js'), 'utf8')
const index = await readFile(join(repositoryRoot, 'docs', 'README.md'), 'utf8')
const quickstart = await readFile(join(repositoryRoot, 'QUICKSTART.md'), 'utf8')
const feedbackLoop = await readFile(
  join(repositoryRoot, 'docs', 'feedback-loop.md'),
  'utf8',
)
const bugForm = await readFile(
  join(repositoryRoot, '.github', 'ISSUE_TEMPLATE', 'bug.yml'),
  'utf8',
)

function runCli(cwd, ...arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd,
    encoding: 'utf8',
  })
}

function code(name) {
  const match = new RegExp(`const ${name} = (\\d+)`, 'u').exec(source)
  assert.ok(match !== null, `src/cli/re.js must define ${name}`)
  return Number(match[1])
}

test('the diagnostics page names the codes the CLI defines', () => {
  for (const [name, expected] of [
    ['EXIT_USAGE', 64],
    ['EXIT_CHECK_FAILURE', 65],
  ]) {
    assert.equal(code(name), expected)
    assert.ok(
      diagnostics.includes(`\`${expected}\``),
      `docs/diagnostics.md must name exit code ${expected}`,
    )
  }
  const tableCodes = [...diagnostics.matchAll(/^\| `(\d+)` \|/gmu)].map(
    (match) => Number(match[1]),
  )
  assert.deepEqual(
    tableCodes,
    [0, code('EXIT_USAGE'), code('EXIT_CHECK_FAILURE')],
    'the exit-code table must list the measured codes in order',
  )
  assert.ok(diagnostics.includes('`process.exit(3)`'))
  assert.ok(diagnostics.includes('`re.check-result@0.1.0`'))
  assert.ok(diagnostics.includes('`input-file-unreadable`'))
  assert.ok(diagnostics.includes('`unexpected-argument`'))
  assert.ok(
    diagnostics.includes(
      'scratch/broken.re:9:28: unexpected-argument (expected data, got message)',
    ),
    'the page must quote the diagnostic exactly as the CLI prints it',
  )
  assert.ok(
    index.includes('(diagnostics.md)'),
    'docs/README.md must link the diagnostics page',
  )
  assert.equal(
    quickstart.split('(docs/diagnostics.md)').length - 1,
    2,
    'QUICKSTART.md must point at the page in both languages',
  )
})

test('the reporting path asks for the fields a report needs', () => {
  // docs/diagnostics.md promises the issue form asks for the same fields its
  // checklist lists. Keep the two from drifting apart: a missing form field
  // makes a report unactionable, and a missing bullet hides the requirement.
  const requirements = [
    'the command you ran',
    'the version you ran it against',
    'your OS and CPU architecture',
    'the smallest input that reproduces it',
    'what you saw and what you expected',
  ]
  for (const requirement of requirements) {
    assert.ok(
      diagnostics.includes(requirement),
      `docs/diagnostics.md must keep the requirement: ${requirement}`,
    )
  }
  assert.ok(diagnostics.includes('including the exit code'))
  for (const [id, label] of [
    ['version', 'Revia version and commit'],
    ['environment', 'OS, architecture, shell'],
    ['command', 'Command and exit status'],
    ['input', 'Minimal `.re` input'],
    ['observed', 'Observed output'],
    ['expected', 'Expected behavior'],
  ]) {
    assert.ok(bugForm.includes(`id: ${id}`), `bug.yml must ask for ${id}`)
    assert.ok(
      bugForm.includes(label),
      `bug.yml must label ${id} as ${label}`,
    )
  }
  assert.ok(
    (bugForm.match(/required: true/gu) ?? []).length >= 6,
    'every reporting field must be required',
  )
  assert.ok(
    diagnostics.includes('../.github/ISSUE_TEMPLATE/bug.yml'),
    'the page must point at the issue form',
  )
  assert.ok(
    feedbackLoop.includes('../.github/ISSUE_TEMPLATE/bug.yml'),
    'the feedback loop must point at the issue form',
  )
})

test('documented exit codes and diagnostics match the CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revia-diagnostics-'))
  try {
    const usage = runCli(directory)
    assert.equal(usage.status, code('EXIT_USAGE'))
    assert.equal(usage.stdout, '')
    assert.match(usage.stderr, /^Usage: re check /u)

    const unknown = runCli(directory, 'does-not-exist')
    assert.equal(unknown.status, code('EXIT_USAGE'))
    assert.equal(unknown.stdout, '')
    assert.match(unknown.stderr, /^Usage: re check /u)

    const missing = runCli(directory, 'check', 'scratch/missing.re')
    assert.equal(missing.status, code('EXIT_CHECK_FAILURE'))
    assert.equal(missing.stdout, '')
    assert.equal(
      missing.stderr,
      'scratch/missing.re: unable to read file (ENOENT)\n',
    )

    const missingJson = runCli(
      directory,
      'check',
      '--format',
      'json',
      'scratch/missing.re',
    )
    assert.equal(missingJson.status, code('EXIT_CHECK_FAILURE'))
    assert.deepEqual(JSON.parse(missingJson.stdout), {
      diagnostics: [
        {
          code: 'input-file-unreadable',
          column: 1,
          file: 'scratch/missing.re',
          line: 1,
          reason: 'ENOENT',
        },
      ],
      file: 'scratch/missing.re',
      ok: false,
      schema: 're.check-result@0.1.0',
    })

    await mkdir(join(directory, 'scratch'), { recursive: true })
    const accepted = await readFile(
      join(repositoryRoot, 'examples', 'hello.re'),
      'utf8',
    )
    await writeFile(join(directory, 'scratch', 'accepted.re'), accepted)
    const ok = runCli(directory, 'check', 'scratch/accepted.re')
    assert.equal(ok.status, 0)
    assert.equal(ok.stdout, 'OK scratch/accepted.re\n')
    assert.equal(ok.stderr, '')

    await writeFile(
      join(directory, 'scratch', 'broken.re'),
      accepted.replace(
        '@stdout.write("Hello, World!\\n")',
        '@stdout.write(message: "Hello, World!\\n")',
      ),
    )
    const rejected = 'scratch/broken.re:9:28: '
      + 'unexpected-argument (expected data, got message)\n'
    for (const command of ['check', 'run']) {
      const result = runCli(directory, command, 'scratch/broken.re')
      assert.equal(result.status, code('EXIT_CHECK_FAILURE'))
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, rejected)
    }

    const brokenJson = runCli(
      directory,
      'check',
      '--format',
      'json',
      'scratch/broken.re',
    )
    assert.equal(brokenJson.status, code('EXIT_CHECK_FAILURE'))
    const parsed = JSON.parse(brokenJson.stdout)
    assert.equal(parsed.schema, 're.check-result@0.1.0')
    assert.equal(parsed.ok, false)
    assert.equal(parsed.file, 'scratch/broken.re')
    assert.equal(parsed.diagnostics.length, 1)
    const [diagnostic] = parsed.diagnostics
    assert.equal(diagnostic.code, 'unexpected-argument')
    assert.equal(diagnostic.file, 'scratch/broken.re')
    assert.equal(diagnostic.line, 9)
    assert.equal(diagnostic.column, 28)
    assert.equal(diagnostic.reference, 'process.stdout@0.1.0')
    assert.equal(diagnostic.member, 'write')
    assert.deepEqual(diagnostic.expected, ['data'])
    assert.equal(diagnostic.actual, 'message')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
