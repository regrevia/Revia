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
    ['EXIT_HOST_FAULT', 70],
  ]) {
    assert.equal(code(name), expected)
    assert.ok(
      diagnostics.includes(`\`${expected}\``),
      `docs/diagnostics.md must name exit code ${expected}`,
    )
  }
  // The page carries a second table for the launcher, whose codes overlap the
  // source CLI's numbers without meaning the same thing. Read each table on
  // its own so neither can drift into the other.
  const [sourceTable, launcherTable = ''] = diagnostics.split(
    '## Launcher exit codes',
  )
  const tableCodes = [...sourceTable.matchAll(/^\| `(\d+)` \|/gmu)].map(
    (match) => Number(match[1]),
  )
  assert.deepEqual(
    tableCodes,
    [0, code('EXIT_USAGE'), code('EXIT_CHECK_FAILURE'), code('EXIT_HOST_FAULT')],
    'the source CLI exit-code table must list the measured codes in order',
  )
  assert.match(launcherTable, /^\| `69` \|/mu)
  assert.match(launcherTable, /^\| `70` \|/mu)
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
    const pinDirectory = join(directory, 'pin')
    await mkdir(pinDirectory)
    const malformedPin = join(pinDirectory, 'malformed.json')
    await writeFile(malformedPin, '{not json')
    const hello = join(repositoryRoot, 'examples', 'hello.re')
    const malformed = runCli(
      directory,
      'run',
      '--format',
      'json',
      '--authority-pin',
      malformedPin,
      hello,
    )
    assert.equal(malformed.status, code('EXIT_HOST_FAULT'))
    assert.deepEqual(JSON.parse(malformed.stdout), {
      outcome: {
        fault: {
          code: 'load-time-authority-pin-json-invalid',
          phase: 'load-time-authority',
        },
        kind: 'host-fault',
      },
      program_stdout: '',
      schema: 're.run-result@0.1.0',
    })
    assert.equal(malformed.stderr, '')
    assert.ok(
      diagnostics.includes(malformed.stdout.trim()),
      'docs/diagnostics.md must quote the measured host-fault result',
    )

    const missingPin = runCli(
      directory,
      'run',
      '--format',
      'json',
      '--authority-pin',
      join(pinDirectory, 'missing.json'),
      hello,
    )
    assert.equal(missingPin.status, code('EXIT_HOST_FAULT'))
    assert.equal(
      JSON.parse(missingPin.stdout).outcome.fault.code,
      'load-time-authority-pin-unreadable',
    )

    const notAPin = join(pinDirectory, 'not-a-pin.json')
    await writeFile(notAPin, '{"schema":"re.authority-pin@9.9.9"}')
    const invalid = runCli(
      directory,
      'run',
      '--format',
      'json',
      '--authority-pin',
      notAPin,
      hello,
    )
    assert.equal(invalid.status, code('EXIT_HOST_FAULT'))
    assert.equal(
      JSON.parse(invalid.stdout).outcome.fault.code,
      'load-time-authority-pin-invalid',
    )

    const pinWithoutJson = runCli(directory, 'run', '--authority-pin', malformedPin, hello)
    assert.equal(pinWithoutJson.status, code('EXIT_USAGE'))
    assert.equal(pinWithoutJson.stdout, '')
    assert.match(
      pinWithoutJson.stderr,
      /^Usage error: --authority-pin requires --format json\n/u,
    )
    assert.ok(
      diagnostics.includes(
        '`Usage error: --authority-pin requires --format json`',
      ),
      'docs/diagnostics.md must name the pin usage error',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the diagnostics page repairs a rejected edit', async () => {
  // The page pairs three rejected edits with the smallest repair. Run each
  // case on a copy of the shipped example and require both the measured line
  // and the repair to hold, so the page cannot drift from the parser.
  const directory = await mkdtemp(join(tmpdir(), 'revia-repair-'))
  try {
    const accepted = await readFile(
      join(repositoryRoot, 'examples', 'hello.re'),
      'utf8',
    )
    const cases = [
      {
        name: 're-0.2.re',
        source: accepted.replace(/^re 0\.1 compact$/mu, 're 0.2 compact'),
        rejection:
          'scratch/re-0.2.re:1:4: unsupported-language-version '
          + '(expected 0.1, got 0.2; phase header; rule '
          + 'header.language-version; repair choose 0.1)\n',
        repair: accepted,
      },
      {
        name: 'no-cap.re',
        source: accepted.replace(/^cap @stdout: .+\n/mu, ''),
        rejection: 'scratch/no-cap.re:8:14: unknown-capability-instance\n',
        repair: accepted,
      },
      {
        name: 'bad-revision.re',
        source: accepted.replace(
          'process.stdout@0.1.0',
          'process.stdout@9.9.9',
        ),
        rejection: 'scratch/bad-revision.re:6:1: missing-schema-revision\n',
        repair: accepted,
      },
    ]
    await mkdir(join(directory, 'scratch'), { recursive: true })
    for (const entry of cases) {
      assert.notEqual(entry.source, accepted, `${entry.name} must be edited`)
      await writeFile(join(directory, 'scratch', entry.name), entry.source)
      const rejected = runCli(directory, 'check', `scratch/${entry.name}`)
      assert.equal(rejected.status, code('EXIT_CHECK_FAILURE'))
      assert.equal(rejected.stdout, '')
      assert.equal(rejected.stderr, entry.rejection)
      assert.ok(
        diagnostics.includes(entry.rejection.trimEnd()),
        `docs/diagnostics.md must quote ${entry.rejection.trimEnd()}`,
      )
      await writeFile(join(directory, 'scratch', entry.name), entry.repair)
      const repaired = runCli(directory, 'check', `scratch/${entry.name}`)
      assert.equal(repaired.status, 0)
      assert.equal(repaired.stderr, '')
    }
    assert.ok(diagnostics.includes('## Repairing a rejected edit / 修复被拒绝的修改'))
    assert.ok(diagnostics.includes('`unknown-capability-instance`'))
    assert.ok(diagnostics.includes('`missing-schema-revision`'))
    assert.ok(diagnostics.includes('`unsupported-language-version`'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the issue form configuration keeps reports on the tracked path', async () => {
  // config.yml decides where a report can go: with blank issues enabled a
  // reporter can skip the form the diagnostics page promises, and a contact
  // link that leaves the repository sends the report somewhere nobody reads.
  const config = await readFile(
    join(repositoryRoot, '.github', 'ISSUE_TEMPLATE', 'config.yml'),
    'utf8',
  )
  assert.match(config, /^blank_issues_enabled: false$/mu, 'blank issues stay disabled')
  const links = config
    .split(/^\s+- name: /mu)
    .slice(1)
    .map((block) => block.split(/^\s+- name: /mu)[0])
  assert.ok(links.length >= 2, `expected the contact links, found ${links.length}`)
  for (const link of links) {
    assert.match(link, /^\s+url: https:\/\/github\.com\/regrevia\/Revia\//mu, link)
    assert.match(link, /^\s+about: \S/mu, link)
  }
})

test('the declared-capability acceptance page cannot claim a state its records do not support', async () => {
  // Issue #27: the acceptance record for the declared-capability slice was read
  // by no gate, so its status sentence, the kind words in its findings tables
  // and the diagnostic tokens it names could drift with every check green.
  const page = await readFile(
    join(repositoryRoot, 'docs', 'work-packages', 'availability.md'),
    'utf8',
  )
  const status = /^Status: (in progress|delivered)\./mu.exec(page)
  assert.ok(status !== null, 'the page must open with a lifecycle status')
  const matrix = JSON.parse(
    await readFile(
      join(repositoryRoot, 'runtime', 'rc2.2.1', 'target-matrix.json'),
      'utf8',
    ),
  )
  const measured = matrix.targets.filter(
    ({ status: state }) => state === 'measured-native',
  )
  assert.equal(
    measured.length,
    2,
    `expected two measured targets, found ${measured.length}`,
  )
  // "Delivered" on a matrix that still lists pending platforms is the edit
  // #27 demonstrates: the status word and the record cannot both be true.
  if (status[1] === 'delivered') {
    assert.equal(
      measured.length,
      matrix.targets.length,
      'a delivered slice leaves no target pending',
    )
  } else {
    assert.ok(
      measured.length < matrix.targets.length,
      'an in-progress slice still has a pending target to close',
    )
  }
  // Finding kinds reuse the four labels section 1 defines; a fifth state word
  // would be a label no reader can resolve and no other record carries.
  const kinds = new Set()
  for (const section of page.split(/^### /mu).slice(1)) {
    if (!/findings|disclosed/iu.test(section.split('\n')[0])) continue
    for (const line of section.split('\n').slice(1)) {
      if (line.startsWith('## ') || line.startsWith('### ')) break
      if (!line.startsWith('| ') || line.includes('---')) continue
      const cells = line.split('|').map((cell) => cell.trim())
      if (cells[2] === 'Kind' || cells[1] === '') continue
      kinds.add(cells[2].split(/\s/u)[0])
    }
  }
  assert.deepEqual(
    [...kinds].sort(),
    ['fault-observed', 'measured', 'pending', 'verified-only'],
    'the findings tables use only the page vocabulary',
  )
  // A named diagnostic that no native source emits would send a reader looking
  // for a token the shipped binary cannot print.
  const tracked = spawnSync('git', ['ls-files', '*.rs'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  assert.equal(tracked.status, 0, tracked.stderr)
  const sources = []
  for (const path of tracked.stdout.split('\n')) {
    if (!path.startsWith('native/revia-cli/src/') && !path.startsWith('native/revia-core/src/')) continue
    sources.push(await readFile(join(repositoryRoot, path), 'utf8'))
  }
  assert.ok(sources.length >= 20, `expected the native sources, found ${sources.length}`)
  const emitted = sources.join('\n')
  const tokens = [...page.matchAll(/`(native-[a-z0-9-]+)/gu)].map((match) => match[1])
  assert.ok(tokens.length >= 8, `expected the documented tokens, found ${tokens.length}`)
  const unemitted = [...new Set(tokens)].filter((token) => !emitted.includes(token))
  assert.deepEqual(unemitted, [], 'every documented diagnostic token is emitted natively')
  // The page sits outside the root-document link sweep, so its own relative
  // links are checked here: a moved evidence file must not leave a dead link.
  const directory = join(repositoryRoot, 'docs', 'work-packages')
  const dead = []
  for (const [, target] of page.matchAll(/\]\(([^)#:\s]+)\)/gu)) {
    try {
      await readFile(join(directory, target))
    } catch {
      dead.push(target)
    }
  }
  assert.deepEqual(dead, [], 'the acceptance page links to files that exist')
})

// The page describes the native CLI's codes as prose, and nothing measured
// them: the object an unreadable input prints could gain or lose a field while
// the page kept quoting the old one. Read the documented object out of the page
// and compare it with the bytes the release binary prints.
test('the diagnostics page documents the object an unreadable native input prints', async () => {
  const start = diagnostics.indexOf('## Native CLI exit codes')
  const end = diagnostics.indexOf('## Launcher exit codes')
  assert.ok(start >= 0 && end > start, 'the page has a native exit-code section')
  const section = diagnostics.slice(start, end)
  const documented = /```text\n(\{[^\n]*\})\n```/u.exec(section)
  assert.ok(documented !== null, 'the section quotes the diagnostic object')
  const expected = JSON.parse(documented[1])
  const root = await mkdtemp(join(tmpdir(), 're-native-unreadable-'))
  try {
    const binary = join(repositoryRoot, 'native', 'target', 'release', 'revia')
    const result = spawnSync(binary, ['digest', 'missing.re'], {
      cwd: root,
      encoding: 'utf8',
    })
    // A checkout that has not built the release binary has nothing to measure.
    if (result.error?.code === 'ENOENT') return
    assert.equal(result.status, 66, result.stderr)
    assert.equal(result.stderr, '', 'the diagnostic goes to stdout only')
    assert.deepEqual(JSON.parse(result.stdout), expected)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
