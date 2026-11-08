import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { posix, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

const ROOT_DOCUMENTS = [
  'README.md',
  'README.zh-CN.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'RELEASE_NOTES.md',
]

function markdownFiles(directory) {
  const files = []
  for (const entry of readdirSync(resolve(repositoryRoot, directory)).sort()) {
    const relativePath = posix.join(directory, entry)
    const absolutePath = resolve(repositoryRoot, relativePath)
    if (statSync(absolutePath).isDirectory()) {
      files.push(...markdownFiles(relativePath))
    } else if (entry.endsWith('.md')) {
      files.push(relativePath)
    }
  }
  return files
}

// Fenced blocks are illustrative text, not documentation structure: a link
// written inside one is never asked to resolve.
function withoutFencedBlocks(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => (/^\s*(```|~~~)/u.test(line) ? '' : line))
    .join('\n')
}

const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)/gu
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu
const HEADING = /^#{1,6}\s+(.*?)\s*$/u
const EXPLICIT_ANCHOR = /<a\s+(?:id|name)\s*=\s*["']([^"']+)["']/giu

// GitHub derives a fragment from the heading text: lowercase, punctuation
// dropped, spaces turned into hyphens. Headings here mix English and Chinese,
// so the rule keeps letters and digits of any script instead of ASCII only.
function headingFragment(heading) {
  return heading
    .replace(/`/gu, '')
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
    .trim()
    .replace(/\s/gu, '-')
    .toLowerCase()
}

function anchorFragments(source) {
  const fragments = new Set()
  for (const line of source.split(/\r?\n/u)) {
    const heading = HEADING.exec(line)
    if (heading !== null) fragments.add(headingFragment(heading[1]))
  }
  for (const match of source.matchAll(EXPLICIT_ANCHOR)) {
    fragments.add(match[1].toLowerCase())
  }
  return fragments
}

test('every relative link in shipped documentation resolves', () => {
  const documents = [
    ...ROOT_DOCUMENTS,
    'docs/README.md',
    ...markdownFiles('docs'),
    'doc/README.md',
    ...markdownFiles('doc'),
  ]
  const failures = []
  let checked = 0
  for (const document of new Set(documents)) {
    const source = withoutFencedBlocks(readFileSync(resolve(repositoryRoot, document), 'utf8'))
    for (const match of source.matchAll(LINK)) {
      const target = match[1]
      if (EXTERNAL.test(target)) continue
      const [path, fragment] = target.split('#')
      if (path === '' && fragment === undefined) continue
      checked += 1
      const fromDocument =
        path === '' ? resolve(repositoryRoot, document) : resolve(repositoryRoot, posix.dirname(document), path)
      const insideRepository =
        fromDocument === repositoryRoot ||
        (relative(repositoryRoot, fromDocument).split(sep)[0] !== '..' &&
          !relative(repositoryRoot, fromDocument).startsWith(`..${sep}`))
      if (!insideRepository || !existsSync(fromDocument)) {
        failures.push(`${document} -> ${target}`)
        continue
      }
      if (fragment === undefined || fragment === '') continue
      if (!anchorFragments(readFileSync(fromDocument, 'utf8').replace(/^\uFEFF/u, '')).has(fragment.toLowerCase())) {
        failures.push(`${document} -> ${target} (no such fragment)`)
      }
    }
  }
  assert.deepEqual(failures, [])
  assert.ok(checked > 150, `expected the documentation link scan to cover the shipped pages, saw ${checked}`)
})
