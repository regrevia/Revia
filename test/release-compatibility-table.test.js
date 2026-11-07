import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

// `docs/compatibility.md` is what a reader uses to decide whether their target
// is supported, but nothing else in the suite binds that table to the release
// records. The release tests prove the evidence files agree with the candidate
// manifest; this file proves the table *uses* those files, so a row cannot be
// flipped or repointed at the wrong evidence while the suite stays green.
const repository = new URL('../', import.meta.url)
const EVIDENCE_DIRECTORY = 'runtime/rc2.2.1'
const SECTION = '## Current RC2.2.1 Candidate'
const NO_EVIDENCE = 'No RC2.2.1 evidence'

// The row set is fixed on purpose: adding or removing a target is a test change,
// not a prose edit. Labels are the exact cell text minus backticks.
const EXPECTED_ROWS = [
  { target: 'darwin-arm64', label: 'macOS arm64', state: 'pending' },
  { target: 'darwin-x64', label: 'macOS x86_64', state: 'pending' },
  { target: 'linux-arm64', label: 'Linux arm64', state: 'pending' },
  { target: 'linux-x64', label: 'Linux x86_64', state: 'measured-native' },
  { target: 'windows-arm64', label: 'Windows arm64', state: 'pending' },
  { target: 'windows-x64', label: 'Windows x86_64', state: 'measured-native' },
]

async function read(relativePath) {
  return readFile(new URL(relativePath, repository), 'utf8')
}

async function readJson(relativePath) {
  return JSON.parse(await read(relativePath))
}

const compatibility = await read('docs/compatibility.md')
const matrix = await readJson(`${EVIDENCE_DIRECTORY}/target-matrix.json`)
const candidate = await readJson(`${EVIDENCE_DIRECTORY}/candidate-manifest.json`)

function section() {
  const start = compatibility.indexOf(`\n${SECTION}`)
  assert.ok(start > 0, `docs/compatibility.md must carry the ${SECTION} heading`)
  const next = compatibility.indexOf('\n## ', start + 1)
  return compatibility.slice(start, next === -1 ? undefined : next)
}

function cells(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
}

function rows() {
  const lines = section().split('\n').filter((line) => line.startsWith('|'))
  // Header, separator, then one row per target.
  return lines.slice(2).map(cells)
}

function labelOf(cell) {
  return cell.replaceAll('`', '')
}

function evidencePathsOf(cell) {
  return [...cell.matchAll(/`([^`]+)`/gu)].map((match) => match[1])
}

test('the compatibility table lists exactly the fixed target set with allowed states', () => {
  const table = rows()
  assert.equal(table.length, EXPECTED_ROWS.length)
  for (const [index, expected] of EXPECTED_ROWS.entries()) {
    const [targetCell, stateCell] = table[index]
    assert.equal(labelOf(targetCell), expected.label)
    const state = labelOf(stateCell)
    assert.ok(
      ['pending', 'measured-native'].includes(state),
      `unknown state ${state} for ${expected.label}`,
    )
    assert.equal(state, expected.state)
  }
})

test('each table row agrees with the target matrix, the only release-state source', () => {
  const byTarget = new Map(matrix.targets.map((entry) => [entry.target, entry.status]))
  assert.equal(byTarget.size, EXPECTED_ROWS.length)
  for (const expected of EXPECTED_ROWS) {
    assert.equal(byTarget.get(expected.target), expected.state, expected.target)
  }
  const table = rows()
  const citedTargets = new Set()
  for (const [targetCell] of table) {
    const label = labelOf(targetCell)
    const row = EXPECTED_ROWS.find((entry) => entry.label === label)
    assert.ok(row, `unexpected table row ${label}`)
    citedTargets.add(row.target)
  }
  assert.deepEqual([...citedTargets].sort(), [...byTarget.keys()].sort())
})

test('measured-native rows cite the evidence file for their own target', async () => {
  const table = rows()
  for (const [targetCell, stateCell, evidenceCell] of table) {
    const label = labelOf(targetCell)
    const state = labelOf(stateCell)
    const row = EXPECTED_ROWS.find((entry) => entry.label === label)
    assert.ok(row, `unexpected table row ${label}`)
    if (state !== 'measured-native') continue

    const paths = evidencePathsOf(evidenceCell)
    assert.equal(paths.length, 1, `${label} must cite exactly one evidence path`)
    const cited = paths[0]
    assert.ok(
      cited.startsWith(`${EVIDENCE_DIRECTORY}/`) && cited.endsWith('-native-evidence.json'),
      `${label} must cite a native evidence file under ${EVIDENCE_DIRECTORY}/`,
    )
    const record = await readJson(cited)
    assert.equal(record.target, row.target, `${cited} records a different target`)
    assert.equal(record.status, 'measured-native')
    assert.equal(record.version, matrix.version)
  }
})

test('pending rows cite no evidence and no evidence record exists for them', async () => {
  const files = (await readdir(new URL(`${EVIDENCE_DIRECTORY}/`, repository)))
    .filter((name) => name.endsWith('-native-evidence.json'))
  const records = await Promise.all(files.map((name) => readJson(`${EVIDENCE_DIRECTORY}/${name}`)))
  const measuredTargets = new Set(
    records.filter((record) => record.status === 'measured-native').map((record) => record.target),
  )

  const table = rows()
  for (const [targetCell, stateCell, evidenceCell] of table) {
    const label = labelOf(targetCell)
    const state = labelOf(stateCell)
    const row = EXPECTED_ROWS.find((entry) => entry.label === label)
    assert.ok(row, `unexpected table row ${label}`)
    if (state !== 'pending') continue
    assert.equal(evidenceCell, NO_EVIDENCE, `${label} must not cite evidence while pending`)
    assert.ok(!measuredTargets.has(row.target), `${label} has an evidence record but the row is pending`)
  }

  // Every measured evidence record must be claimed by a measured-native row.
  const measuredRows = EXPECTED_ROWS.filter((entry) => entry.state === 'measured-native')
  assert.deepEqual(
    [...measuredTargets].sort(),
    measuredRows.map((entry) => entry.target).sort(),
  )
  assert.deepEqual(
    [...measuredTargets].sort(),
    candidate.targets.map((target) => target.target).sort(),
  )
})
