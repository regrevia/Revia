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
    // The example pages are first-run documentation too: they are reached from
    // the shipped pages and tell a reader what to run.
    ...markdownFiles('examples'),
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

// The pull request template is the one page every contributor reads before a
// change, and the link scan above never reached it because it walks `docs`,
// `doc` and `examples`. The licence link and the agreement checkbox it carries
// are the contributor's part of the release contract, so they are checked from
// the file's own directory.
test('the pull request template links resolve and keep the licence agreement', () => {
  const template = readFileSync(
    resolve(repositoryRoot, '.github/pull_request_template.md'),
    'utf8'
  )
  const links = [...template.matchAll(LINK)]
    .map((match) => match[1])
    .filter((target) => !EXTERNAL.test(target))
  assert.ok(links.length >= 1, 'the template links nothing')
  const missing = links.filter(
    (target) => !existsSync(resolve(repositoryRoot, '.github', target.split('#')[0]))
  )
  assert.deepEqual(missing, [], 'every template link resolves from .github')
  assert.match(
    template,
    /^\s*- \[ \] I agree to \[LICENSE\]\(\.\.\/LICENSE\)/mu,
    'the template keeps the licence agreement checkbox'
  )
})

// Decision records cite source by path and line: `native/.../vm.rs:417`. A
// citation that names a moved file or a line past the end of it reads as
// evidence while pointing at nothing, so every whole-repository citation in
// `docs/` is asked to resolve to a file that has that line.
const CITATION = /`([A-Za-z0-9_][A-Za-z0-9_./-]*\/[A-Za-z0-9_.-]+\.(?:rs|js|mjs|sh|md|json)):(\d+)(?:-(\d+))?`/gu

test('every source citation in the documentation resolves', () => {
  const unresolvable = []
  for (const document of markdownFiles('docs')) {
    const source = withoutFencedBlocks(readFileSync(resolve(repositoryRoot, document), 'utf8'))
    for (const match of source.matchAll(CITATION)) {
      const [, cited, first, last = first] = match
      const absolutePath = resolve(repositoryRoot, cited)
      if (!existsSync(absolutePath)) {
        unresolvable.push(`${document} cites missing ${cited}`)
        continue
      }
      const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/u).length
      if (Number(last) > lines) {
        unresolvable.push(`${document} cites ${cited} line ${last} of ${lines}`)
      }
    }
  }
  assert.deepEqual(unresolvable, [], 'every citation points inside a file that exists')
})
