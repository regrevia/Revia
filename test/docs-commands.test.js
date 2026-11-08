import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const ROOT_DOCUMENTS = ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'AGENTS.md', 'RELEASE_NOTES.md']

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
  ...topLevelPages('doc')
]

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
    for (const match of source.matchAll(/node src\/cli\/re\.js ([a-z][a-z-]+)/gu)) {
      if (!subcommands.has(match[1])) unknown.push(`${document} -> node src/cli/re.js ${match[1]}`)
    }
  }
  assert.ok(subcommands.size >= 10, `re --help lists ${subcommands.size} subcommands`)
  assert.deepEqual(unknown, [])
})
