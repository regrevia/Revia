import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { posix, resolve } from 'node:path'
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
