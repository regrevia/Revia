import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const ROOT_DOCUMENTS = ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'AGENTS.md', 'RELEASE_NOTES.md']

function markdownFiles(directory) {
  const files = []
  for (const entry of readdirSync(resolve(repositoryRoot, directory), { withFileTypes: true })) {
    const relativePath = posix.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...markdownFiles(relativePath))
    else if (entry.name.endsWith('.md')) files.push(relativePath)
  }
  return files.sort()
}

function topLevelPages(directory) {
  return readdirSync(resolve(repositoryRoot, directory))
    .filter((entry) => entry.endsWith('.md') && entry !== 'README.md')
    .map((entry) => posix.join(directory, entry))
    .sort()
}

const documents = [
  ...ROOT_DOCUMENTS,
  'docs/README.md',
  'doc/README.md',
  ...topLevelPages('docs'),
  ...topLevelPages('doc'),
  // The example pages are where a reader first types these commands.
  ...markdownFiles('examples'),
  // Project and experiment pages hand the same commands to a fresh reader.
  ...markdownFiles('projects'),
  ...markdownFiles('experiments')
]

// A documented command is only runnable when it carries the arguments the CLI
// refuses to run without. `project-check` without `--format json` exits 64.
const REQUIRED_ARGUMENTS = new Map([
  ['audit', ['--format json']],
  ['build', ['--out']],
  ['module-surface', ['--manifest']],
  ['patch', ['--patch']],
  ['project-check', ['--format json']],
  ['project-projection', ['--routes', '--out']],
  ['project-run', ['--fixture']],
  ['translate', ['--format json']]
])

// Both shapes appear in the documents, and long commands wrap with a trailing
// backslash, so the check reads the joined invocation rather than one line.
function documentedInvocations(source) {
  const joined = source.replace(/\\\n/gu, ' ')
  const invocations = []
  for (const match of joined.matchAll(/(?:node src\/cli\/re\.js|npm run (?:--silent )?re --) ([a-z][a-z-]+)/gu)) {
    const rest = joined.slice(match.index, joined.indexOf('\n', match.index))
    invocations.push({ remainder: rest.slice(match[0].length), subcommand: match[1] })
  }
  return invocations
}

function cliSubcommands() {
  let output = ''
  try {
    output = execFileSync(process.execPath, [resolve(repositoryRoot, 'src/cli/re.js'), '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    // Usage text is printed to stderr and the documented usage exit code is 64.
    if (error.status !== 64) throw new Error(`re --help failed: ${error.message}`)
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const subcommands = new Set()
  for (const match of output.matchAll(/\bre ([a-z][a-z-]+)/gu)) subcommands.add(match[1])
  return subcommands
}

test('documented npm scripts are the scripts package.json defines', () => {
  const declared = new Set(Object.keys(JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')).scripts))
  const unknown = []
  for (const document of documents) {
    const source = readFileSync(resolve(repositoryRoot, document), 'utf8')
    // `npm run --silent <script> -- ...` puts the package flag before the name.
    for (const match of source.matchAll(/npm run (?!-)([\w:-]+)/gu)) {
      if (!declared.has(match[1])) unknown.push(`${document} -> npm run ${match[1]}`)
    }
  }
  assert.ok(declared.size >= 5, `package.json declares ${declared.size} scripts`)
  assert.deepEqual(unknown, [])
})

test('documented CLI subcommands are the subcommands the CLI accepts', () => {
  const subcommands = cliSubcommands()
  const unknown = []
  for (const document of documents) {
    const source = readFileSync(resolve(repositoryRoot, document), 'utf8')
    for (const { subcommand } of documentedInvocations(source)) {
      if (!subcommands.has(subcommand)) unknown.push(`${document} -> ${subcommand}`)
    }
  }
  assert.ok(subcommands.size >= 10, `re --help lists ${subcommands.size} subcommands`)
  assert.deepEqual(unknown, [])
})

test('documented invocations carry the arguments the CLI requires', () => {
  const incomplete = []
  let invocations = 0
  for (const document of documents) {
    const source = readFileSync(resolve(repositoryRoot, document), 'utf8')
    for (const { remainder, subcommand } of documentedInvocations(source)) {
      invocations += 1
      for (const argument of REQUIRED_ARGUMENTS.get(subcommand) ?? []) {
        if (!remainder.includes(argument)) incomplete.push(`${document} -> ${subcommand} ${argument}`)
      }
    }
  }
  assert.ok(invocations >= 30, `documents carry ${invocations} invocations`)
  assert.ok(REQUIRED_ARGUMENTS.size >= 5, `rules cover ${REQUIRED_ARGUMENTS.size} subcommands`)
  assert.deepEqual(incomplete, [])
})

// The agent entry page is the first instruction an outside evaluator follows.
// It lists the evaluate commands as bare backticked words instead of
// documented invocations, so the scan above never saw them; a renamed
// subcommand left the page telling a reader to run a command the CLI rejects.
test('the agent workflow names commands the CLI exposes', () => {
  const page = readFileSync(resolve(repositoryRoot, 'docs/agent-workflow.md'), 'utf8')
  const step = page.match(/^2\. Run (.+)$/mu)
  assert.ok(step, 'docs/agent-workflow.md no longer lists the evaluate commands')
  const named = [...step[1].matchAll(/`([a-z][a-z-]+)`/gu)].map((match) => match[1])
  assert.ok(named.length >= 4, `the evaluate step names ${named.length} commands`)
  const subcommands = cliSubcommands()
  const unknown = named.filter((name) => !subcommands.has(name))
  assert.deepEqual(unknown, [], 'the evaluate step names a command the CLI does not expose')
})

test('the integration guide quotes the projection a consumer reads', () => {
  // docs/integration.md tells an outside consumer what `project-projection`
  // writes and shows the three lines a plain Node reader gets. Re-run both so
  // the envelope names, file list and route in the guide stay measured.
  const directory = mkdtempSync(join(tmpdir(), 'revia-projection-guide-'))
  const out = join(directory, 'client')
  const result = spawnSync(
    process.execPath,
    [
      resolve(repositoryRoot, 'src/cli/re.js'),
      'project-projection',
      '--routes',
      resolve(repositoryRoot, 'examples/agent-expense-review/interface-routes.json'),
      '--out',
      out,
      resolve(repositoryRoot, 'examples/agent-expense-review')
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)

  const projection = JSON.parse(readFileSync(join(out, 'projection.json'), 'utf8'))
  assert.equal(projection.schema, 're.interface-projection-manifest@0.1.0')
  assert.deepEqual(Object.keys(projection).sort(), [
    'contract',
    'files',
    'projection_digest',
    'schema'
  ])
  assert.deepEqual(projection.files.map((file) => file.path).sort(), ['client.ts', 'types.ts'])
  const route = projection.contract.operations[0].route
  assert.equal(`${route.method} ${route.path}`, 'POST /v1/expense/review')

  const consumer = spawnSync(
    process.execPath,
    [
      '-e',
      'const p = require("./client/projection.json");\n' +
        'console.log(p.schema);\n' +
        'console.log(p.files.map((f) => f.path).join(","));\n' +
        'const operation = p.contract.operations[0];\n' +
        'console.log(operation.route.method, operation.route.path)'
    ],
    { cwd: directory, encoding: 'utf8' }
  )
  assert.equal(consumer.status, 0, consumer.stderr)
  assert.equal(consumer.stdout, `${projection.schema}\nclient.ts,types.ts\nPOST /v1/expense/review\n`)

  const guide = readFileSync(resolve(repositoryRoot, 'docs/integration.md'), 'utf8')
  assert.ok(
    guide.includes(consumer.stdout.trimEnd()),
    'docs/integration.md must quote the consumer output as one block'
  )
  assert.ok(guide.includes('`re.interface-projection-manifest@0.1.0`'))
  assert.ok(guide.includes('`projection.json`'))
  assert.ok(guide.includes('`projection_digest`'))
})

test('the feedback guide says which version and input a report needs', () => {
  // The bug form requires a version, commit and minimal input. The guide must
  // name the commands that produce them, and the diagnostic shape it quotes
  // must match a real rejection.
  const guide = readFileSync(resolve(repositoryRoot, 'docs/feedback-loop.md'), 'utf8')
  const { engines } = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
  const version = /^version = "(.+)"$/mu
    .exec(readFileSync(resolve(repositoryRoot, 'native/Cargo.toml'), 'utf8'))[1]

  assert.ok(guide.includes('native/Cargo.toml'))
  assert.ok(guide.includes('git rev-parse --short HEAD'))
  assert.ok(guide.includes('`node --version`'))
  assert.ok(guide.includes(`node ${engines.node}`))
  assert.ok(
    guide.includes(`release version (\`${version}\` in the current tree)`),
    `docs/feedback-loop.md must quote ${version} from native/Cargo.toml`
  )
  assert.ok(guide.includes('`65`'))
  assert.ok(guide.includes('path:line:column: code (expected …, got …)'))

  const printed = execFileSync(
    process.execPath,
    [
      '-p',
      "require('fs').readFileSync('native/Cargo.toml', 'utf8').match(/^version = \"(.+)\"$/m)[1]"
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  assert.equal(printed.trim(), version)

  const directory = mkdtempSync(join(tmpdir(), 'revia-report-guide-'))
  writeFileSync(join(directory, 'broken.re'), 're 0.1 compact\nunit @broken\n')
  const rejected = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, 'src/cli/re.js'), 'check', join(directory, 'broken.re')],
    { encoding: 'utf8' }
  )
  assert.equal(rejected.status, 65)
  assert.equal(rejected.stdout, '')
  assert.match(rejected.stderr, /^.+:\d+:\d+: [a-z-]+ \(expected .+, got .+\)$/mu)
})

test('the integration guide runs the built artifact outside the repository', () => {
  // docs/integration.md tells an integrator that `build` writes a directory
  // plain Node can run. Re-run the two documented commands, then move the
  // directory and run it from elsewhere with a PATH-only environment, so the
  // page cannot claim portability the artifact does not have.
  const directory = mkdtempSync(join(tmpdir(), 'revia-build-guide-'))
  const out = join(directory, 'hello')
  const result = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, 'src/cli/re.js'), 'build', '--out', out, resolve(repositoryRoot, 'examples/hello.re')],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const envelope = JSON.parse(result.stdout)
  assert.equal(envelope.schema, 're.build-result@0.1.0')
  assert.equal(envelope.ok, true)
  assert.equal(envelope.artifact.target_profile, 'node-demo-self-contained-preview@0.1.0')
  assert.equal(envelope.artifact.runtime.kind, 'self-contained-node-demo-runtime')
  assert.equal(envelope.artifact.runtime.entrypoint, 'run.mjs')

  const files = readdirSync(out).sort()
  assert.deepEqual(files, [
    'checksums.sha256',
    'manifest.json',
    'program.re',
    'release-lock.json',
    'review-index.json',
    'run.mjs',
    'semantic-view.json'
  ])
  const checksums = readFileSync(join(out, 'checksums.sha256'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(/\s+/u)[1])
  assert.deepEqual(checksums.sort(), files.filter((file) => file !== 'checksums.sha256'))

  const shipped = join(directory, 'shipped')
  cpSync(out, shipped, { recursive: true })
  const run = spawnSync(process.execPath, [join(shipped, 'run.mjs')], {
    cwd: directory,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' }
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, 'Hello, World!\n')

  const nonEmpty = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, 'src/cli/re.js'), 'build', '--out', out, resolve(repositoryRoot, 'examples/hello.re')],
    { encoding: 'utf8' }
  )
  assert.equal(nonEmpty.status, 65)
  assert.deepEqual(JSON.parse(nonEmpty.stdout).diagnostics, [
    { code: 'build-write-failed', reason: 'ENOTEMPTY' }
  ])

  const missingParent = spawnSync(
    process.execPath,
    [
      resolve(repositoryRoot, 'src/cli/re.js'),
      'build',
      '--out',
      join(directory, 'absent', 'hello'),
      resolve(repositoryRoot, 'examples/hello.re')
    ],
    { encoding: 'utf8' }
  )
  assert.equal(missingParent.status, 65)
  assert.deepEqual(JSON.parse(missingParent.stdout).diagnostics, [
    { code: 'build-write-failed', reason: 'ENOENT' }
  ])

  const guide = readFileSync(resolve(repositoryRoot, 'docs/integration.md'), 'utf8')
  assert.ok(guide.includes('node /tmp/revia-hello/run.mjs'))
  assert.ok(
    guide.includes('Hello, World!'),
    'docs/integration.md must quote the artifact output'
  )
  assert.ok(guide.includes('`re.build-result@0.1.0`'))
  assert.ok(guide.includes('`re.build-artifact@0.1.0`'))
  assert.ok(guide.includes('`node-demo-self-contained-preview@0.1.0`'))
  assert.ok(guide.includes('`shasum -a 256 -c checksums.sha256`'))
  assert.ok(guide.includes('`ENOENT`'))
  assert.ok(guide.includes('`ENOTEMPTY`'))
  assert.ok(guide.includes('kind: self-contained-node-demo-runtime'))
})

test('the expense-review example runs its checked fixture', () => {
  // The example README tells a reader to drive one bounded run with
  // `project-run` and its checked-in fixture. Re-run that command twice, so
  // the page cannot claim a stable receipt digest the run does not produce.
  const example = resolve(repositoryRoot, 'examples/agent-expense-review')
  const run = () => spawnSync(
    process.execPath,
    [
      resolve(repositoryRoot, 'src/cli/re.js'),
      'project-run',
      '--fixture',
      resolve(repositoryRoot, 'examples/agent-expense-review-run.json'),
      example
    ],
    { encoding: 'utf8' }
  )

  const first = run()
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.stderr, '')
  const envelope = JSON.parse(first.stdout)
  assert.equal(envelope.schema, 're.project-run-result@0.1.0')
  assert.equal(envelope.ok, true)
  assert.equal(envelope.receipt.schema, 're.project-run-receipt@0.3.0')
  assert.equal(envelope.receipt.replay.attempts, 2)
  assert.equal(envelope.receipt.typed_outcome.value.approved, true)

  const second = run()
  assert.equal(second.status, 0, second.stderr)
  assert.equal(
    JSON.parse(second.stdout).receipt.receipt_digest,
    envelope.receipt.receipt_digest
  )

  const withoutFixture = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, 'src/cli/re.js'), 'project-run', example],
    { encoding: 'utf8' }
  )
  assert.equal(withoutFixture.status, 64)
  assert.equal(withoutFixture.stdout, '')

  const readme = readFileSync(join(example, 'README.md'), 'utf8')
  assert.ok(readme.includes('node src/cli/re.js project-run'))
  assert.ok(readme.includes('`re.project-run-result@0.1.0`'))
  assert.ok(readme.includes('`re.project-run-receipt@0.3.0`'))
  assert.ok(readme.includes('`attempts: 2`'))
  assert.ok(readme.includes('`typed_outcome.value.approved`'))
  assert.ok(readme.includes('`--fixture`'))
  assert.ok(readme.includes('`missing-project-run-selection-field`'))
  assert.ok(readme.includes('`project-run-graph-revision-mismatch`'))
  assert.ok(readme.includes('`project-run-case-not-found`'))

  const scratch = mkdtempSync(join(tmpdir(), 'revia-project-run-'))
  const selection = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'examples/agent-expense-review-run.json'), 'utf8')
  )
  const rejected = (name, mutate) => {
    const path = join(scratch, name)
    writeFileSync(path, JSON.stringify(mutate(structuredClone(selection))))
    const result = spawnSync(
      process.execPath,
      [resolve(repositoryRoot, 'src/cli/re.js'), 'project-run', '--fixture', path, example],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 65, result.stderr)
    const body = JSON.parse(result.stdout)
    assert.equal(body.schema, 're.project-run-result@0.1.0')
    assert.equal(body.ok, false)
    assert.equal(body.fixture, path)
    return body.diagnostics
  }

  assert.deepEqual(rejected('empty.json', () => ({})), [
    { code: 'missing-project-run-selection-field' }
  ])
  assert.deepEqual(rejected('stale.json', (value) => {
    value.graph_revision = `sha256:${'0'.repeat(64)}`
    return value
  }), [{ code: 'project-run-graph-revision-mismatch' }])
  assert.deepEqual(rejected('unknown-case.json', (value) => {
    value.case = 'agent.expense.intake.missing'
    return value
  }), [{ code: 'project-run-case-not-found' }])
})

test('the project example documents its module-digest repair path', () => {
  // The README's modification steps send a reader to a scratch copy, then to
  // the native surface check. Re-run the stale-digest failure and, when the
  // release binary exists, the surface envelope the page promises.
  const example = resolve(repositoryRoot, 'examples/agent-expense-review')
  const readme = readFileSync(join(example, 'README.md'), 'utf8')
  assert.ok(readme.includes('`project-module-source-digest-mismatch`'))
  assert.ok(readme.includes('`native/target/release/revia project-surface-check`'))
  assert.ok(readme.includes('`re.native-project-surface-result@0.1.0`'))
  assert.ok(readme.includes('`interface-routes.json`'))
  assert.ok(readme.includes('`project-module-implementation-digest-mismatch`'))
  assert.ok(readme.includes('`project-run-graph-revision-mismatch`'))

  const scratch = mkdtempSync(join(tmpdir(), 'revia-project-module-'))
  const copy = join(scratch, 'agent-expense-review')
  cpSync(example, copy, { recursive: true })
  const modulePath = join(copy, 'modules', 'api.re')
  writeFileSync(modulePath, `${readFileSync(modulePath, 'utf8')}\n`)

  const stale = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, 'src/cli/re.js'), 'project-check', '--format', 'json', copy],
    { encoding: 'utf8' }
  )
  assert.equal(stale.status, 65, stale.stderr)
  const body = JSON.parse(stale.stdout)
  assert.equal(body.schema, 're.project-check-result@0.1.0')
  assert.equal(body.ok, false)
  assert.equal(body.diagnostics.length, 1)
  assert.equal(body.diagnostics[0].code, 'project-module-source-digest-mismatch')
  assert.equal(body.diagnostics[0].module, 'agent.expense.api')
  assert.equal(body.diagnostics[0].path, 'modules/api.re')
  assert.match(body.diagnostics[0].expected, /^sha256:[0-9a-f]{64}$/u)
  assert.match(body.diagnostics[0].actual, /^sha256:[0-9a-f]{64}$/u)

  // The page promises a two-pin repair: the stale digest names the module, and
  // writing the actual digest into both pinned fields reopens the check.
  const manifestPath = join(copy, 'project.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const name = body.diagnostics[0].module
  const actual = body.diagnostics[0].actual
  const entry = manifest.modules.find((module) => module.name === name)
  assert.ok(entry)
  entry.source_sha256 = actual
  const packaged = manifest.package_manifest.modules.find((module) => module.name === name)
  assert.ok(packaged)
  packaged.implementation_digest = actual
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const repaired = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, 'src/cli/re.js'), 'project-check', '--format', 'json', copy],
    { encoding: 'utf8' }
  )
  assert.equal(repaired.status, 0, repaired.stdout)
  assert.equal(JSON.parse(repaired.stdout).ok, true)

  // A change to a capability binding is not rejected by the checks themselves;
  // the run gate closes because the fixture pins the pre-edit graph revision.
  const policyPath = join(copy, 'modules', 'policy.re')
  const policy = readFileSync(policyPath, 'utf8')
  const capability = 'capability agent.expense.policy.db write db.write@0.1.0'
  assert.ok(policy.includes(capability))
  const edited = policy.replace(
    capability,
    'capability agent.expense.policy.db read db.read@0.1.0'
  )
  writeFileSync(policyPath, edited)
  const editedDigest = `sha256:${createHash('sha256').update(edited).digest('hex')}`
  const rebound = JSON.parse(readFileSync(manifestPath, 'utf8'))
  rebound.modules.find((module) => module.name === 'agent.expense.policy').source_sha256 =
    editedDigest
  rebound.package_manifest.modules.find(
    (module) => module.name === 'agent.expense.policy'
  ).implementation_digest = editedDigest
  writeFileSync(manifestPath, `${JSON.stringify(rebound, null, 2)}\n`)
  const reboundCheck = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, 'src/cli/re.js'), 'project-check', '--format', 'json', copy],
    { encoding: 'utf8' }
  )
  assert.equal(reboundCheck.status, 0, reboundCheck.stdout)

  const blocked = spawnSync(
    process.execPath,
    [
      resolve(repositoryRoot, 'src/cli/re.js'),
      'project-run',
      '--fixture',
      resolve(repositoryRoot, 'examples/agent-expense-review-run.json'),
      copy,
    ],
    { encoding: 'utf8' }
  )
  assert.equal(blocked.status, 65, blocked.stderr)
  assert.equal(
    JSON.parse(blocked.stdout).diagnostics[0].code,
    'project-run-graph-revision-mismatch'
  )

  const binary = resolve(repositoryRoot, 'native/target/release/revia')
  if (!existsSync(binary)) return
  const native = spawnSync(binary, ['project-surface-check', example], { encoding: 'utf8' })
  assert.equal(native.status, 0, native.stderr)
  const surface = JSON.parse(native.stdout)
  assert.equal(surface.schema, 're.native-project-surface-result@0.1.0')
  assert.equal(surface.ok, true)
  assert.equal(surface.module_count, 6)
  const pinned = JSON.parse(
    readFileSync(join(example, 'interface-routes.json'), 'utf8')
  ).graph_revision
  assert.notEqual(surface.graph_revision, pinned)
})

// The protocol page is the only place users read the status numbers, and no
// test compared them to the code that emits them: a renumbered constant or a
// new launcher status could leave the page quoting a set that no longer exists.
test('the protocol page lists the statuses the CLI and the launcher emit', () => {
  const page = readFileSync(resolve(repositoryRoot, 'docs/protocol.md'), 'utf8')
  const documented = [...page.matchAll(/^\| `(\d+)` \|/gmu)].map((match) => Number(match[1]))
  assert.equal(new Set(documented).size, documented.length, 'the protocol table repeats a status')
  const cli = readFileSync(resolve(repositoryRoot, 'src/cli/re.js'), 'utf8')
  const launcher = readFileSync(resolve(repositoryRoot, 'bin/revia'), 'utf8')
  const emitted = new Set([
    0,
    ...[...cli.matchAll(/const EXIT_[A-Z_]+ = (\d+)/gu)].map((match) => Number(match[1])),
    ...[...launcher.matchAll(/\bexit (\d+)/gu)].map((match) => Number(match[1])),
  ])
  assert.deepEqual(
    [...documented].sort((left, right) => left - right),
    [...emitted].sort((left, right) => left - right)
  )
})

// The evolution timeline is the only page that links into `RELEASE_NOTES.md`
// anchors. Those anchors are explicit `<a id>` tags, so a renamed or moved id
// silently produces a dead timeline link; nothing read them.
test('the evolution timeline links resolve to release-note anchors', () => {
  const tracked = execFileSync('git', ['ls-files', '*.md'], { cwd: repositoryRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  const notes = readFileSync(resolve(repositoryRoot, 'RELEASE_NOTES.md'), 'utf8')
  const anchored = new Map()
  for (const match of notes.matchAll(/<a id="([^"]+)"><\/a>\s*\n(#+ [^\n]+)/gu)) {
    anchored.set(match[1], match[2])
  }
  for (const relativePath of tracked) {
    const page = readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
    for (const match of page.matchAll(/\]\((?:[^)\s]*?)RELEASE_NOTES\.md#([^)\s]+)\)/gu)) {
      assert.ok(
        anchored.has(match[1]),
        `${relativePath} links to a missing RELEASE_NOTES.md anchor: ${match[1]}`
      )
    }
  }
  const evolution = readFileSync(resolve(repositoryRoot, 'docs/evolution.md'), 'utf8')
  const rows = [...evolution.matchAll(/^\| `([0-9][0-9a-z.-]*)` \|.*RELEASE_NOTES\.md#([^)\s]+)\) \|$/gmu)]
  assert.ok(rows.length > 0, 'the evolution timeline has no version rows')
  const versions = rows.map((match) => match[1])
  assert.equal(new Set(versions).size, versions.length, 'the evolution timeline repeats a version')
  for (const match of rows) {
    const version = match[1]
    const heading = anchored.get(match[2])
    assert.ok(heading, `docs/evolution.md cites ${version} without a ${match[2]} anchor`)
    // Both historical preview releases share one section by design; every
    // later release has its own version-named section.
    const historical = version.startsWith('0.1-preview') && heading.includes('Historical Preview')
    assert.ok(
      historical || heading.includes(`v${version}`),
      `the ${match[2]} anchor does not precede the ${version} heading`
    )
  }
})

// Documentation quotes schema identifiers that consumers branch on. Nothing
// compared them to the tree, so a renamed identifier left the page telling
// readers to switch on a string no command emits.
test('every schema identifier a current page quotes exists in the tree', () => {
  const tracked = execFileSync('git', ['ls-files', '*.md'], { cwd: repositoryRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  // `doc/` is the retired pre-public design tree and `docs/work-packages/`
  // records plans, so neither is a statement about the current tree.
  const pages = tracked.filter(
    (relativePath) =>
      !relativePath.startsWith('doc/') && !relativePath.startsWith('docs/work-packages/')
  )
  const identifier = /`((?:re|revia)\.[a-z0-9.-]+@[0-9]+\.[0-9]+\.[0-9]+)`/gu
  const quoted = new Map()
  for (const relativePath of pages) {
    const page = readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
    for (const match of page.matchAll(identifier)) {
      if (!quoted.has(match[1])) quoted.set(match[1], new Set())
      quoted.get(match[1]).add(relativePath)
    }
  }
  assert.ok(quoted.size > 0, 'no current page quotes a schema identifier')
  // `git grep` reads POSIX ERE, so the search pattern drops the markdown
  // backticks and the non-capturing group used for parsing a page.
  const present = new Set(
    execFileSync(
      'git',
      [
        'grep',
        '-IhoE',
        '(re|revia)\\.[a-z0-9.-]+@[0-9]+\\.[0-9]+\\.[0-9]+',
        '--',
        ':(exclude)*.md',
        // A test asserting an identifier is not the product emitting it.
        ':(exclude)test/**',
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    )
      .split('\n')
      .filter(Boolean)
  )
  for (const [schema, sources] of quoted) {
    assert.ok(
      present.has(schema),
      `${[...sources].sort().join(', ')} quotes a schema identifier no tracked file emits: ${schema}`
    )
  }
})

// The rendering page said `view` supported the text form, but the command
// answers `--format text` with the usage block: the page listed a capability
// the CLI rejects. The format list is a claim about the CLI, so derive it from
// the shipped usage line and check the rejection instead of trusting prose.
test('the rendering page names exactly the formats the view command accepts', () => {
  const page = readFileSync(resolve(repositoryRoot, 'docs/translation-rendering.md'), 'utf8')
  const cli = readFileSync(resolve(repositoryRoot, 'src/cli/re.js'), 'utf8')
  const usage = cli.match(/re view \[--locale (zh-CN)\|(en-US)\] \[--format ([a-z|]+)\] <file\.re>/u)
  assert.ok(usage, 'the view usage line changed shape')
  const [, firstLocale, secondLocale, formatList] = usage
  const formats = formatList.split('|')
  const rendered = formats.map((format) => format.toUpperCase()).join(' and ')
  assert.match(
    page,
    new RegExp(
      `The \`view\` command supports \`${firstLocale}\` and \`${secondLocale}\` for ${rendered}\\.`,
      'u',
    ),
  )

  const source = resolve(repositoryRoot, 'examples/adversarial-review/case-01-two-sum/main.re')
  const run = (format) =>
    spawnSync(
      process.execPath,
      ['src/cli/re.js', 'view', '--locale', firstLocale, '--format', format, source],
      { cwd: repositoryRoot, encoding: 'utf8' },
    )
  for (const format of formats) {
    assert.notEqual(run(format).status, 64, `view rejects the documented ${format} format`)
  }
  const rejected = run('text')
  assert.equal(rejected.status, 64, 'view accepted a format the page does not document')
  assert.match(rejected.stderr, /re view \[--locale zh-CN\|en-US\] \[--format html\|svg\]/u)
})

// The invocation scan above reads subcommand names and required flags, so a
// code fence may still hand a reader a `.re` input that no longer exists: a
// renamed or moved example leaves every documented command unrunnable while
// the subcommand and flag checks keep passing.
test('documented example inputs exist', () => {
  const referenced = new Set()
  for (const document of documents) {
    const source = readFileSync(resolve(repositoryRoot, document), 'utf8')
    for (const match of source.matchAll(/(?:examples|projects|experiments)\/[^\s'"`()\[\]]+\.re\b/gu)) {
      const target = match[0]
      // `examples/<case>.re` and `examples/*.re` are shapes, not paths.
      if (/[<>*]/u.test(target)) continue
      referenced.add(target)
    }
  }
  assert.ok(referenced.size >= 10, `documents reference ${referenced.size} example inputs`)
  const missing = [...referenced].filter((target) => !existsSync(resolve(repositoryRoot, target)))
  assert.deepEqual(missing, [], 'a document runs an input this repository does not ship')
})
