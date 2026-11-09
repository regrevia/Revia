import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// A reader on a target that the candidate never published should be told that
// the target is pending, not that the checkout is damaged. `bin/revia` used to
// report every absent release record as `Missing checksum` with exit 70, which
// reads as a host fault on the most common developer platform (macOS arm64).
// The synthetic roots below pin the three distinct outcomes: pending target
// (exit 69), damaged release records (exit 70), and checksums that name no
// asset for the current version (exit 70).
const ZERO_DIGEST = '0'.repeat(64)

function hostPlatformName() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  }
  return `windows-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
}

async function createLauncherRoot(version, checksums) {
  const root = await mkdtemp(join(tmpdir(), 'revia-launcher-pending-'))
  await mkdir(join(root, 'bin'), { recursive: true })
  await mkdir(join(root, 'runtime'), { recursive: true })
  await copyFile(new URL('../bin/revia', import.meta.url), join(root, 'bin/revia'))
  await chmod(join(root, 'bin/revia'), 0o755)
  await writeFile(join(root, 'VERSION'), `${version}\n`)
  if (checksums !== null) {
    await writeFile(join(root, 'runtime/checksums.txt'), checksums)
  }
  return root
}

function runLauncher(root) {
  return spawnSync(join(root, 'bin/revia'), ['check', 'example.re'], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('the launcher reports an unpublished target as pending, not as damage', { skip: process.platform === 'win32' }, async () => {
  const version = '9.9.9-test'
  const unpublished = `${ZERO_DIGEST}  revia-${version}-zzz.tar.gz\n${ZERO_DIGEST}  revia-${version}-zzz\n`
  const root = await createLauncherRoot(version, unpublished)
  try {
    const result = runLauncher(root)
    const output = `${result.stdout}${result.stderr}`
    assert.equal(result.status, 69, output)
    assert.match(output, /has a pending target/u)
    assert.match(output, new RegExp(hostPlatformName(), 'u'))
    assert.match(output, /release asset is recorded for this candidate/u)
    assert.match(output, /docs\/compatibility\.md/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the launcher still reports damaged release records as a runtime fault', { skip: process.platform === 'win32' }, async () => {
  const version = '9.9.9-test'
  const missing = await createLauncherRoot(version, null)
  try {
    const result = runLauncher(missing)
    const output = `${result.stdout}${result.stderr}`
    assert.equal(result.status, 70, output)
    assert.match(output, /Release checksums file is unavailable\./u)
    assert.match(output, /Revia runtime error/u)
  } finally {
    await rm(missing, { recursive: true, force: true })
  }

  const otherVersion = `${ZERO_DIGEST}  revia-1.0.0-rc.1-darwin-arm64.tar.gz\n${ZERO_DIGEST}  revia-1.0.0-rc.1-darwin-arm64\n`
  const unrelated = await createLauncherRoot(version, otherVersion)
  try {
    const result = runLauncher(unrelated)
    const output = `${result.stdout}${result.stderr}`
    assert.equal(result.status, 70, output)
    assert.match(output, new RegExp(`Release checksums have no entries for ${version.replaceAll('.', '\\.')}`, 'u'))
  } finally {
    await rm(unrelated, { recursive: true, force: true })
  }
})

test('both launchers keep the pending-target and damaged-record paths', async () => {
  const shell = await readFile(new URL('../bin/revia', import.meta.url), 'utf8')
  const windows = await readFile(new URL('../bin/revia.ps1', import.meta.url), 'utf8')
  for (const launcher of [shell, windows]) {
    assert.match(launcher, /has a pending target/u)
    assert.match(launcher, /release asset is recorded for this candidate/u)
    assert.match(launcher, /Release checksums file is unavailable\./u)
    assert.match(launcher, /Release checksums have no entries for/u)
  }
  assert.match(windows, /Duplicate checksum for/u)

  // The table a reader lands on must explain the code they just saw.
  const compatibility = await readFile(new URL('../docs/compatibility.md', import.meta.url), 'utf8')
  assert.match(compatibility, /`bin\/revia` reports\s+`pending target` and exits 69/u)
  assert.match(compatibility, /Exit 70 means the checkout's\s+release records are damaged/u)

  // A reader who starts from the quickstart must learn the same exit code
  // before they hit it on a pending host.
  const quickstart = await read('QUICKSTART.md')
  assert.match(quickstart, /bin\/revia` runs a command only for a target/u)
  assert.match(quickstart, /it exits `69`\s+with `pending target`/u)
  assert.match(quickstart, /native\/target\/release\/revia/u)

  const executionContract = await read('docs/execution-contract.md')
  assert.match(executionContract, /reports\s+`pending target` and exits `69`/u)
  assert.match(executionContract, /\[compatibility matrix\]\(compatibility\.md\)/u)
  const executionContractZh = await read('docs/execution-contract.zh-CN.md')
  assert.match(executionContractZh, /`pending target` 并以 `69` 退出/u)

  const examplesIndex = await read('examples/README.md')
  assert.match(examplesIndex, /reports\s+`pending target` and exits `69`/u)
  assert.match(examplesIndex, /\[compatibility matrix\]\(\.\.\/docs\/compatibility\.md\)/u)

  for (const relativePath of [
    'examples/adversarial-review/case-01-two-sum/README.md',
    'examples/adversarial-review/case-02-retry-counter/README.md',
    'examples/adversarial-review/case-03-handoff-report/README.md',
    'examples/challenges/README.md',
    'examples/reviewed-file-plan/README.md',
  ]) {
    const page = await read(relativePath)
    assert.match(page, /report[s]?\s+`pending target` and exits? `69`/u, relativePath)
    assert.match(
      page,
      /\[compatibility matrix\]\(\.\.\/(?:\.\.\/){1,2}docs\/compatibility\.md\)/u,
      relativePath,
    )
  }

  const languageReference = await read('docs/language-reference.md')
  assert.match(languageReference, /reports\s+`pending target` and exits `69`/u)
  assert.match(languageReference, /\[compatibility matrix\]\(compatibility\.md\)/u)

  // `docs/language.md` used to tell readers to run `revia --help` on macOS
  // arm64 for rc.1, which is where the current candidate is not measured. The
  // version it names is now a historical note, and the matrix is the pointer.
  const languageGuide = await read('docs/language.md')
  assert.match(languageGuide, /\[compatibility matrix\]\(compatibility\.md\)/u)
  assert.match(languageGuide, /rc\.1 deep-trial command contract/u)
  assert.match(languageGuide, /rc\.1 的深度试用命令契约/u)
  assert.doesNotMatch(languageGuide, /For `v1\.0\.0-rc\.1`, run `revia --help`/u)
  assert.doesNotMatch(languageGuide, /对于 `v1\.0\.0-rc\.1`，请在 macOS arm64 运行/u)

  // The diagnostics page is where an exit code is looked up. It describes the
  // source CLI, so the launcher's own codes need their own row and pointer.
  const diagnostics = await read('docs/diagnostics.md')
  assert.match(diagnostics, /\| `69` \|[^\n]*pending/u)
  assert.match(diagnostics, /pending target/u)
  assert.match(diagnostics, /\[compatibility matrix\]\(compatibility\.md\)/u)
})

// The count was not bound to any matrix, so it could not tell a reader which
// candidate it described: `runtime/rc1/target-matrix.json` has five pending
// rows (RC1 measured darwin-arm64), `runtime/rc2.2.1/target-matrix.json` has
// four. A numeric count in these two pages must match one of those matrices,
// and it has to stay correct if a row changes.
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}
const CN_NUMERALS = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}
const COUNTED_DOCUMENTS = ['docs/compatibility.md', 'docs/evidence.md']

async function pendingRowCount(relativePath) {
  const matrix = JSON.parse(await read(relativePath))
  return matrix.targets.filter((row) => row.status === 'pending').length
}

test('prose counts of pending targets match a published matrix', async () => {
  const pending = new Set([
    await pendingRowCount('runtime/rc1/target-matrix.json'),
    await pendingRowCount('runtime/rc2.2.1/target-matrix.json'),
  ])
  for (const relativePath of COUNTED_DOCUMENTS) {
    const text = await read(relativePath)
    for (const match of text.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten) pending targets\b/giu)) {
      assert.ok(
        pending.has(NUMBER_WORDS[match[1].toLowerCase()]),
        `${relativePath} says "${match[0]}" but no matrix has ${NUMBER_WORDS[match[1].toLowerCase()]} pending rows (${[...pending].join(', ')})`,
      )
    }
    for (const match of text.matchAll(/([一二三四五六七八九十])个 pending 目标/gu)) {
      assert.ok(
        pending.has(CN_NUMERALS[match[1]]),
        `${relativePath} says "${match[0]}" but no matrix has ${CN_NUMERALS[match[1]]} pending rows (${[...pending].join(', ')})`,
      )
    }
  }
})

// `scripts/test-launchers.sh` is the hand-run launcher contract: it exercises
// the real `./bin/revia` entry point, including the pending-target refusal. It
// is not part of the tracked Node population, so without this case nothing
// would notice when the script stops matching the launcher.
test(
  'the launcher shell contract script passes',
  { skip: process.platform === 'win32' ? 'requires a POSIX shell' : false },
  () => {
    const result = spawnSync('sh', [fileURLToPath(new URL('../scripts/test-launchers.sh', import.meta.url))], {
      cwd: fileURLToPath(repository),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /launcher checks passed/u)
  },
)
