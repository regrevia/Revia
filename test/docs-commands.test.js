import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
