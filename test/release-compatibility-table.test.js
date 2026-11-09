import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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

  // The rc.1 kit names its runner `./bin/revia` because the runner copies the
  // binary it is given into its own directory. The repository path of that
  // name is the launcher for the current candidate, so the contract has to
  // send readers to an installed path instead.
  const trialContract = await read('docs/rc1-trial-kit-contract.md')
  assert.match(
    trialContract,
    /REVIA_EXECUTABLE=\/path\/to\/revia-1\.0\.0-rc\.1-darwin-arm64/u,
  )
  assert.match(trialContract, /runner binary digest\s+mismatch/u)
  assert.doesNotMatch(trialContract, /REVIA_EXECUTABLE=\.\/bin\/revia/u)
  assert.match(trialContract, /hash-bound fixture text/u)

  // The kit's own fixtures are bound to the accepted rc.1 export, so the
  // verifier is the only thing that keeps a well-meaning README edit from
  // invalidating a sealed record. Nothing else executes it on a push.
  const kitVerification = spawnSync(
    'sh',
    [
      fileURLToPath(new URL('../scripts/verify-rc1-trial-kit.sh', import.meta.url)),
      fileURLToPath(new URL('../experiments/rc1/kit', import.meta.url)),
      fileURLToPath(new URL('../runtime/rc1/export-manifest.json', import.meta.url)),
    ],
    { cwd: fileURLToPath(repository), encoding: 'utf8' },
  )
  assert.equal(kitVerification.status, 0, kitVerification.stderr)
  assert.match(
    kitVerification.stdout,
    /RC1 trial kit verified: 1\.0\.0-rc\.1 darwin-arm64 [0-9a-f]{64}/u,
  )

  // The kit tree itself ships no `bin/` directory, so the pages around it
  // have to name an install path the runner actually reads.
  for (const guide of ['experiments/rc1/README.md', 'docs/evidence.md']) {
    const text = await read(guide)
    assert.match(text, /`REVIA_EXECUTABLE`/u, guide)
    assert.doesNotMatch(text, /at `(?:kit\/)?bin\/revia`/u, guide)
    assert.doesNotMatch(text, /安装到 `bin\/revia`/u, guide)
  }
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

// `experiments/rc1/README.md` describes the accepted trial kit in prose: how
// many trials the manifest binds and how many targets are still pending. Both
// numbers were unread, so a trial or matrix row could be added while the page
// kept describing the old kit.
test('deep-trial guide counts match the manifest and the rc.1 matrix', async () => {
  const manifest = JSON.parse(await read('experiments/rc1/kit/trial-manifest.json'))
  assert.equal(manifest.status, 'measured-native')
  assert.equal(manifest.target, 'darwin-arm64')
  const pending = await pendingRowCount('runtime/rc1/target-matrix.json')
  const guide = await read('experiments/rc1/README.md')

  function wordOf(count) {
    const found = Object.entries(NUMBER_WORDS).find(([, value]) => value === count)
    assert.ok(found, `no number word is recorded for ${count}`)
    return found[0]
  }
  function cnOf(count) {
    const found = Object.entries(CN_NUMERALS).find(([, value]) => value === count)
    assert.ok(found, `no Chinese numeral is recorded for ${count}`)
    return found[0]
  }

  assert.match(guide, new RegExp(`binds ${wordOf(manifest.trials.length)} trials\\b`, 'u'))
  assert.match(guide, new RegExp(`将${cnOf(manifest.trials.length)}个试验`, 'u'))
  assert.match(guide, new RegExp(`其他${cnOf(pending)}个目标仍为 \`pending\``, 'u'))
  assert.match(guide, /`darwin-arm64`/u)
})

// `docs/cross-platform-evidence.md` restates the RC1 matrix and republishes the
// rc.2.1 digests, but no test read the page: a matrix row, a status, or a record
// could change while the evidence procedure kept quoting the old values.
test('cross-platform evidence matches the rc.1 matrix and the rc.2.1 record', async () => {
  const matrix = JSON.parse(await read('runtime/rc1/target-matrix.json'))
  const evidence = JSON.parse(await read('runtime/rc2.1/native-evidence.json'))
  const exportManifest = JSON.parse(await read('runtime/rc2.1/export-manifest.json'))
  assert.equal(exportManifest.target, evidence.target)
  const guide = await read('docs/cross-platform-evidence.md')

  const OS_KEYS = { macOS: 'darwin', Linux: 'linux', Windows: 'windows' }
  const section = guide.split('## RC1 Matrix')[1].split('## RC2.1')[0]
  const rows = [
    ...section.matchAll(/^\| (macOS|Linux|Windows) ([a-z0-9]+) \| `([^`]+)` \| `([a-z-]+)` \|$/gmu),
  ]
  assert.equal(rows.length, matrix.targets.length)
  const published = new Map(rows.map(([, os, arch, runner, status]) => [
    `${OS_KEYS[os]}-${arch}`,
    { runner, status },
  ]))
  for (const row of matrix.targets) {
    const publishedRow = published.get(row.target)
    assert.ok(publishedRow, `the RC1 table omits ${row.target}`)
    assert.equal(publishedRow.runner.length > 0, true, `${row.target} names no runner`)
    assert.equal(publishedRow.status, row.status, `the RC1 table gives ${row.target} the wrong state`)
  }

  assert.ok(guide.includes(`\`${evidence.archive_sha256.replace(/^sha256:/u, '')}\``))
  assert.ok(guide.includes(`\`${evidence.binary_sha256.replace(/^sha256:/u, '')}\``))

  const count = matrix.targets.length
  const word = Object.entries(NUMBER_WORDS).find(([, value]) => value === count)[0]
  const cn = Object.entries(CN_NUMERALS).find(([, value]) => value === count)[0]
  assert.match(guide, new RegExp(`this ${word}-target matrix`, 'u'))
  assert.match(guide, new RegExp(`此${cn}目标矩阵`, 'u'))
})

// `docs/development-status.md` publishes how many cases pin the declared-call
// and host-boundary slices. The Rust drivers iterate whatever the fixtures
// hold, so the page could keep quoting a stale count after a case was added or
// removed; no Node test read either fixture.
test('development status corpus counts match the conformance fixtures', async () => {
  const status = await read('docs/development-status.md')
  const fixtures = [
    ['test/fixtures/declared-capability-execution-corpus.json', '-case CLI conformance corpus'],
    ['test/fixtures/host-boundary-refusal-corpus.json', '-case CLI corpus'],
  ]
  for (const [relativePath, suffix] of fixtures) {
    const corpus = JSON.parse(await read(relativePath))
    const ids = corpus.cases.map((entry) => entry.id)
    assert.equal(new Set(ids).size, ids.length, `${relativePath} repeats a case id`)
    assert.match(
      status,
      new RegExp(`\\b${corpus.cases.length}${suffix}`, 'u'),
      `docs/development-status.md does not publish ${corpus.cases.length}${suffix}`
    )
  }
})

// `docs/rc1-license-and-limitations.md` tells a reader which targets the first
// RC asset covers, but no test read the page: the matrix could measure another
// target, or the page could announce one early, while the boundary stayed
// unbound and described the shipped asset as still planned.
test('the rc.1 license page covers only the targets the matrix measures', async () => {
  const matrix = JSON.parse(await read('runtime/rc1/target-matrix.json'))
  const page = await read('docs/rc1-license-and-limitations.md')
  const section = page.split('## Initial RC boundary')[1]
  assert.ok(section, 'the license page has no initial RC boundary section')

  const LABELS = {
    'darwin-arm64': 'macOS arm64',
    'darwin-x64': 'macOS x64',
    'linux-arm64': 'Linux arm64',
    'linux-x64': 'Linux x64',
    'windows-arm64': 'Windows arm64',
    'windows-x64': 'Windows x64',
  }
  const labelOf = (target) => {
    const label = LABELS[target]
    assert.ok(label, `no page label is recorded for ${target}`)
    return label
  }
  assert.equal(
    matrix.targets.length,
    Object.keys(LABELS).length,
    'the rc.1 matrix and the label table disagree on the target set',
  )
  for (const row of matrix.targets) {
    const label = labelOf(row.target)
    if (row.status === 'measured-native') {
      assert.match(section, new RegExp(`native ${label} only`, 'u'))
    } else {
      assert.equal(
        section.includes(label),
        false,
        `the boundary claims unmeasured ${row.target}`,
      )
    }
  }
  assert.equal(
    section.includes('is planned for'),
    false,
    'the boundary still calls the shipped asset planned',
  )
})

// `docs/android-termux-experimental-contract.md` tells a reader Android is an
// additive experimental target that neither satisfies nor weakens the desktop
// set, but no test read the page: a matrix that grew an Android row, or lost a
// desktop target, would leave the boundary quoting a count it no longer has.
test('the android contract leaves the desktop matrix untouched', async () => {
  const matrix = await readJson(`${EVIDENCE_DIRECTORY}/target-matrix.json`)
  const page = await read('docs/android-termux-experimental-contract.md')
  assert.match(page, /`android-arm64`/u)
  const android = matrix.targets.filter((row) => row.target.startsWith('android-'))
  assert.deepEqual(android, [], 'the desktop matrix carries an android target')
  const count = matrix.targets.length
  const word = Object.entries(NUMBER_WORDS).find(([, value]) => value === count)?.[0]
  assert.ok(word, `no number word is recorded for ${count}`)
  const cn = Object.entries(CN_NUMERALS).find(([, value]) => value === count)?.[0]
  assert.ok(cn, `no Chinese numeral is recorded for ${count}`)
  assert.match(page, new RegExp(`the ${word} desktop\\s+\\w+ requirements`, 'u'))
  assert.match(page, new RegExp(`的${cn}桌面目标`, 'u'))
})
// `docs/server-conformance.md` publishes the bounded Server slice as measured
// evidence, but no test read `runtime/rc1/server-evidence.json`: the page could
// keep describing a two-module Darwin arm64 rc.1 slice after the evidence moved
// to another target, version, or module count, or after the matrix measured a
// second target the page still calls out of scope.
test('server conformance page matches the rc.1 server evidence', async () => {
  const evidence = await readJson('runtime/rc1/server-evidence.json')
  const matrix = await readJson('runtime/rc1/target-matrix.json')
  const page = await read('docs/server-conformance.md')

  assert.equal(evidence.status, 'measured-native')
  const measured = matrix.targets.filter((row) => row.status === evidence.status)
  assert.deepEqual(
    measured.map((row) => row.target),
    [evidence.target],
    'the rc.1 matrix measures targets the server evidence does not cover',
  )

  assert.equal(evidence.target, 'darwin-arm64')
  assert.ok(page.includes('Darwin arm64'), 'the page does not bind the evidence target')
  assert.ok(
    page.includes(`\`v${evidence.version}\``),
    'the page does not name the evidence version',
  )
  assert.match(page, /measured native bounded Server\s+slice/u)

  const word = Object.entries(NUMBER_WORDS).find(([, value]) => value === evidence.module_count)?.[0]
  assert.ok(word, `no number word is recorded for ${evidence.module_count}`)
  const english = `${word[0].toUpperCase()}${word.slice(1)}-module`
  assert.ok(page.includes(english), `the page does not publish ${english}`)
  const CN_LIANG = { '两': 2 }
  const cn = [...Object.entries(CN_LIANG), ...Object.entries(CN_NUMERALS)]
    .find(([, value]) => value === evidence.module_count)?.[0]
  assert.ok(cn, `no Chinese numeral is recorded for ${evidence.module_count}`)
  assert.ok(page.includes(`${cn}模块`), `the page does not publish ${cn}模块`)
})
// The sealed export contract is the only accepted bridge from private
// development, yet no test read it: its eleven-file inventory, manifest
// identity, and six-target matrix were prose only. An export that shipped a
// different payload set, schema, tag, or measured target would leave the
// contract describing a bridge that no longer exists.
test('the sealed export contract lists the manifest payloads', async () => {
  const page = await read('docs/rc1-sealed-export-contract.md')
  const manifest = await readJson('runtime/rc1/export-manifest.json')
  const matrix = await readJson('runtime/rc1/target-matrix.json')

  assert.equal(manifest.schema, 'revia.public-rc-export@1.0.0')
  for (const value of [manifest.schema, manifest.tag, manifest.version, manifest.target]) {
    assert.ok(page.includes(value), `the contract does not name ${value}`)
  }

  const inventory = page.slice(page.indexOf('exactly these eleven regular files'))
  const block = inventory.match(/```text\n([\s\S]*?)```/u)
  assert.ok(block, 'the contract no longer shows a file inventory')
  const names = block[1].trim().split('\n').map((line) => line.trim())
  assert.equal(names.length, 11)
  assert.ok(names.includes('export-manifest.json'))
  const payloads = names.filter((name) => name !== 'export-manifest.json').sort()
  assert.deepEqual(
    manifest.files.map((file) => file.path).sort(),
    payloads,
    'the manifest ships a payload set the contract does not list',
  )
  const countWord = Object.entries(NUMBER_WORDS)
    .find(([, value]) => value === payloads.length)?.[0]
  assert.ok(countWord, `no number word is recorded for ${payloads.length}`)
  assert.ok(
    page.includes(`describes the other ${countWord} payloads`),
    `the contract does not describe the other ${countWord} payloads`,
  )

  assert.equal(matrix.schema, 'revia.public-target-matrix@1.0.0')
  const measured = matrix.targets.filter((row) => row.status === 'measured-native')
  assert.deepEqual(measured.map((row) => row.target), [manifest.target])
  const matrixWord = Object.entries(NUMBER_WORDS)
    .find(([, value]) => value === matrix.targets.length)?.[0]
  assert.ok(matrixWord, `no number word is recorded for ${matrix.targets.length}`)
  assert.ok(
    page.includes(`exactly ${matrixWord} target records`),
    `the contract does not publish ${matrixWord} target records`,
  )
})
// The expansion contract promises each desktop target a hosted runner, but no
// test compared those promises with the gate matrix. A runner image bump in
// release-gate.yml, or a native conformance workflow on a different image,
// would leave the page describing machines that never build the target.
test('the target expansion contract names the gate runners', async () => {
  const page = await read('docs/rc2-target-expansion-contract.md')
  const gate = await read('.github/workflows/release-gate.yml')
  const matrix = gate.slice(gate.indexOf('matrix:'))
  const runners = new Map(
    [...matrix.matchAll(/- runner: (\S+)\n\s+target: (\S+)/gu)].map(
      (match) => [match[2], match[1]],
    ),
  )
  assert.equal(runners.size, 6)

  const native = [
    ['linux-x64', '.github/workflows/linux-native.yml'],
    ['windows-x64', '.github/workflows/windows-native.yml'],
  ]
  const chinese = page.slice(page.indexOf('下一次原生接收顺序'))
  for (const [target, workflowPath] of native) {
    const runner = runners.get(target)
    assert.ok(runner, `${target} is missing from the gate matrix`)
    const workflow = await read(workflowPath)
    assert.match(
      workflow,
      new RegExp(`^\\s+runs-on: ${runner}$`, 'mu'),
      `${workflowPath} no longer runs on ${runner}`,
    )
    assert.ok(
      page.includes(`\`${target}\` on GitHub-hosted \`${runner}\``),
      `the contract does not place ${target} on ${runner}`,
    )
    assert.match(
      chinese,
      new RegExp(`\`${runner}\` 上的\\s+\`${target}\``, 'u'),
      `the Chinese contract does not place ${target} on ${runner}`,
    )
  }

  const armRunner = runners.get('linux-arm64')
  assert.match(gate, new RegExp(`- runner: ${armRunner}\\n\\s+target: linux-arm64`, 'u'))
  assert.ok(
    page.includes(`\`linux-arm64\` on GitHub-hosted \`${armRunner}\``),
    `the contract does not place linux-arm64 on ${armRunner}`,
  )
})
// The load-time authority page tells readers that four builtin members are the
// whole language-visible surface, but nothing compared that promise with the
// checker's supported-operation table. A fifth accepted operation would leave
// the page understating what the runtime executes.
test('the load-time authority page lists the builtin table', async () => {
  const page = await read('docs/load-time-authority.md')
  const checker = await read('src/toolchain/checker.js')
  const table = checker.slice(checker.indexOf('function isSupportedDemoOperation'))
  const pairs = [
    ...table.slice(0, table.indexOf('\n}\n')).matchAll(
      /\(reference === '([^']+)' && member === '([^']+)'\)/gu,
    ),
  ].map((match) => match[1].replace(/@[^@]+$/u, ''))
  assert.equal(pairs.length, 4)
  const families = [...new Set(pairs)].sort()

  const listed = page.slice(
    page.indexOf('Four builtin members ('),
    page.indexOf(') plus the `process.exit` status domain'),
  )
  assert.notEqual(listed, '')
  const named = listed
    .slice(listed.indexOf('(') + 1)
    .split(',')
    .map((name) => name.trim().replace(/^`|`$/gu, ''))
    .sort()
  assert.deepEqual(named, families)
  assert.match(page, /Four builtin members \(/u)
})
// The rc.2.2.1 matrix is what readers quote as target readiness, while the
// native evidence files are what was measured. No test paired the two: a row
// could stay `measured-native` after its evidence moved to another version, or
// a pending target could carry a measured record.
test('the rc.2.2.1 matrix marks exactly the targets with native evidence', async () => {
  const matrix = await readJson(`${EVIDENCE_DIRECTORY}/target-matrix.json`)
  const entries = await readdir(new URL(`${EVIDENCE_DIRECTORY}/`, repository))
  const records = await Promise.all(
    entries
      .filter((name) => name.endsWith('native-evidence.json'))
      .map((name) => readJson(`${EVIDENCE_DIRECTORY}/${name}`)),
  )
  const withEvidence = records.map((record) => record.target).sort()
  assert.equal(withEvidence.length, new Set(withEvidence).size)
  const measured = matrix.targets
    .filter((row) => row.status === 'measured-native')
    .map((row) => row.target)
    .sort()
  assert.deepEqual(withEvidence, measured)
  for (const record of records) {
    assert.equal(record.status, 'measured-native')
    assert.equal(record.version, matrix.version)
  }
})
// `capability-evidence.json`, `multi-module-evidence.json`, and
// `server-evidence.json` record the measured conformance runs inside the
// candidate release, but no test read them: a candidate bump, or a matrix that
// measured another target, would leave the records naming a run for a release
// or target that no longer exists.
test('the capability records cover exactly the measured targets', async () => {
  const canonical = await readJson(`${EVIDENCE_DIRECTORY}/candidate-manifest.json`)
  const matrix = await readJson(`${EVIDENCE_DIRECTORY}/target-matrix.json`)
  const measured = matrix.targets
    .filter((row) => row.status === 'measured-native')
    .map((row) => row.target)
    .sort()
  let scope
  const runs = {}
  for (const name of [
    'capability-evidence.json',
    'multi-module-evidence.json',
    'server-evidence.json',
  ]) {
    const record = await readJson(`${EVIDENCE_DIRECTORY}/${name}`)
    assert.equal(record.version, canonical.version)
    assert.equal(record.source_commit, canonical.source_commit)
    assert.equal(record.status, 'measured-native')
    scope ??= record.scope
    assert.equal(record.scope, scope, `${name} describes another conformance scope`)
    const workflows = Object.keys(record)
      .filter((key) => key.endsWith('_workflow'))
      .sort()
    assert.deepEqual(
      workflows,
      measured.map((target) => `${target.replace(/-/gu, '_')}_workflow`),
    )
    for (const key of workflows) {
      assert.ok(Number.isInteger(record[key]) && record[key] > 0, `${name}.${key} is not a run id`)
      if (key in runs) {
        assert.equal(record[key], runs[key], `${name}.${key} names another run`)
      } else {
        runs[key] = record[key]
      }
    }
  }
})

// `experiments/rc1/kit/trial-manifest.json` is the reproducible input for the
// RC1 trial: it lists every file the runner copies and hashes. Nothing checked
// those digests against the files in the tree, so a fixture could drift or go
// missing while the manifest kept publishing the old hash.
test('the RC1 trial manifest covers and matches the kit it lists', async () => {
  const manifest = JSON.parse(await read('experiments/rc1/kit/trial-manifest.json'))
  const base = 'experiments/rc1/kit'
  const listed = new Set()
  for (const file of manifest.files) {
    assert.equal(listed.has(file.path), false, `the manifest lists ${file.path} twice`)
    listed.add(file.path)
    const contents = await readFile(new URL(`${base}/${file.path}`, repository))
    assert.equal(file.size, contents.length, `${file.path} changed size`)
    assert.equal(file.sha256, createHash('sha256').update(contents).digest('hex'), `${file.path} changed contents`)
  }
  const present = []
  async function walk(relative) {
    for (const entry of await readdir(new URL(`${base}/${relative}`, repository), { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(next)
      } else {
        present.push(next)
      }
    }
  }
  await walk('')
  const unlisted = present
    .filter((path) => path !== 'trial-manifest.json' && path !== 'checksums.txt')
    .filter((path) => !listed.has(path))
  assert.deepEqual(unlisted, [], 'the kit ships files the manifest does not hash')
})
