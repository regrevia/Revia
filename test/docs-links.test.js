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

// A named path resolves when it exists, or when it is the documented shorthand
// for a sibling file such as `doc/04` standing for `doc/04-translation.md`.
function namedPathResolves(target) {
  if (existsSync(resolve(repositoryRoot, target))) return true
  const parent = posix.dirname(target)
  const base = posix.basename(target)
  const parentPath = resolve(repositoryRoot, parent)
  if (!existsSync(parentPath) || !statSync(parentPath).isDirectory()) return false
  return readdirSync(parentPath).some((entry) => entry.startsWith(base))
}

function topLevelPages(directory) {
  return readdirSync(resolve(repositoryRoot, directory))
    .filter((entry) => entry.endsWith('.md') && entry !== 'README.md')
    .map((entry) => posix.join(directory, entry))
    .sort()
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

test('the documentation map reaches every page it indexes', () => {
  const map = 'docs/README.md'
  const source = withoutFencedBlocks(readFileSync(resolve(repositoryRoot, map), 'utf8'))
  const linked = new Set()
  for (const match of source.matchAll(LINK)) {
    const target = match[1]
    if (EXTERNAL.test(target)) continue
    const path = target.split('#')[0]
    if (path === '') continue
    linked.add(relative(repositoryRoot, resolve(repositoryRoot, 'docs', path)))
  }
  // The map indexes the shipped top-level pages. Records under
  // `docs/work-packages/` and the local promotion and planning notes are
  // reached from the pages that cite them, not from the map.
  const pages = topLevelPages('docs')
  const orphans = pages.filter((page) => !linked.has(page))
  assert.deepEqual(orphans, [])
  assert.ok(pages.length > 20, `expected the map to cover the shipped pages, saw ${pages.length}`)
})

test('every repository path named in shipped documentation exists', () => {
  const documents = [
    ...ROOT_DOCUMENTS,
    'docs/README.md',
    'doc/README.md',
    ...topLevelPages('docs'),
    ...topLevelPages('doc')
  ]
  const NAMED_PATH =
    /`((?:docs|doc|examples|src|native|scripts|test\/fixtures|projects|feedback)\/[^`\s]+)`/gu
  const missing = []
  for (const document of documents) {
    const source = withoutFencedBlocks(readFileSync(resolve(repositoryRoot, document), 'utf8'))
    for (const match of source.matchAll(NAMED_PATH)) {
      const target = match[1].replace(/[.,]+$/u, '').replace(/:\d+(?:-\d+)?$/u, '')
      // Glob patterns describe a whole set, `<...>` names a shape rather than a
      // path, and build output is described in prose but only exists after a
      // local build.
      if (target.includes('*') || target.includes('<') || target.startsWith('native/target/')) continue
      if (!namedPathResolves(target)) missing.push(`${document} -> ${target}`)
    }
  }
  assert.deepEqual(missing, [])
})
