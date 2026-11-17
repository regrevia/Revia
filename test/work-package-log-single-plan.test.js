// The work-package log is the acceptance record for the availability slice, and
// it is edited by hand between rounds. A splice that pasted the whole page back
// into the middle of an entry went unnoticed for seven commits: the file carried
// the plan four times, and two entries were cut in half where the copy landed.
// Nothing read the page's shape, so nothing could tell a second record from a
// second copy of the first.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const ROOT = new URL('../', import.meta.url)
const LOG = 'docs/work-packages/availability.md'
const GUIDE = 'AGENTS.md'
const TITLE = '# Availability Work Package: Declared Capability Execution Closure'
const PLAN = '## 1. What "available" means on this page'

const read = async (path) => readFile(new URL(path, ROOT), 'utf8')

// The page's shape, as a list of complaints, so a synthesised copy can be put
// through the same audit the tracked page is held to.
function audit(text) {
  const problems = []
  const lines = text.split('\n')

  const titles = lines.filter((line) => line.includes(TITLE))
  if (titles.length !== 1) problems.push(`title appears ${titles.length} times`)
  for (const line of titles) {
    if (line !== TITLE) problems.push('title is not a line of its own')
  }

  const plans = lines.filter((line) => line === PLAN).length
  if (plans !== 1) problems.push(`plan section appears ${plans} times`)

  const numbers = []
  for (const line of lines) {
    const match = /^#{2,3} WP-(\d+) — /u.exec(line)
    if (match) numbers.push(Number(match[1]))
  }
  const repeated = numbers.filter((n, i) => numbers.indexOf(n) !== i)
  if (repeated.length > 0) problems.push(`work package ${repeated[0]} appears twice`)
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] >= numbers[i - 1]) {
      problems.push(`work package ${numbers[i]} does not follow ${numbers[i - 1]}`)
      break
    }
  }
  if (numbers.length === 0) problems.push('no work package entries')

  return problems
}

test('the log carries one plan and one entry per work package', async () => {
  const text = await read(LOG)
  assert.deepEqual(audit(text), [])
  assert.ok(audit(text).length === 0)
})

test('a second copy of the plan is reported, not counted as a second record', () => {
  // Built here rather than cut from the log, so the case is about what the
  // audit does with a copy and not about the shape the log happens to have.
  const page = [
    TITLE,
    '',
    PLAN,
    'body of the plan',
    '## 2. Measured snapshot',
    'measured',
    '### WP-2 — the newer one',
    'entry',
    '### WP-1 — the older one',
    'entry',
  ]
  assert.deepEqual(audit(page.join('\n')), [])

  const start = page.indexOf(PLAN)
  const end = page.indexOf('## 2. Measured snapshot')
  const { length } = page.slice(start, end)
  const spliced = [...page.slice(0, start), ...page.slice(start, end), ...page.slice(start)]
  const problems = audit(spliced.join('\n'))
  assert.ok(
    problems.includes('plan section appears 2 times'),
    `expected the copied plan to be reported, got ${JSON.stringify(problems)}`,
  )
  // Nothing else is wrong with the copy, so the repeat is the whole finding.
  assert.deepEqual(problems, ['plan section appears 2 times'])
  assert.equal(spliced.length, page.length + length)
})

test('a title spliced onto the middle of a line is reported', async () => {
  const text = await read(LOG)
  const [first, ...rest] = text.split('\n')
  assert.equal(first, TITLE)
  const spliced = [`${first}${first}`, ...rest].join('\n')
  const problems = audit(spliced)
  assert.ok(
    problems.includes('title is not a line of its own'),
    `expected the glued title to be reported, got ${JSON.stringify(problems)}`,
  )
})

test('the guide says the log carries each entry once', async () => {
  const guide = await read(GUIDE)
  // The guide is hard-wrapped, so a phrase assertion has to survive the line
  // breaks the prose puts in the middle of it.
  const flat = guide.replace(/\s+/gu, ' ')
  assert.match(
    flat,
    /one copy of the plan followed by one entry per work package, newest first; a second copy of either is a bad splice rather than a second record, so `test\/work-package-log-single-plan\.test\.js`/u,
  )
})
