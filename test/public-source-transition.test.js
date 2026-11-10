import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  readFileSync,
  readdirSync,
  lstatSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

test('root source license is the unmodified MPL 2.0 text', () => {
  const license = readFileSync(join(ROOT, 'LICENSE'))
  assert.equal(
    digest(license),
    '66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172',
  )
})

test('the previous preview license is preserved as a historical asset license', () => {
  const license = readFileSync(join(ROOT, 'LICENSE-PREVIEW-0.1.md'))
  assert.equal(
    digest(license),
    'b84614f5bbb51bc14902aaf409bfde37c6f4d6cf99a7b2d1eead94e5ebe849fc',
  )
})

test('the RC1 license and sealed archive digests remain unchanged', () => {
  const license = readFileSync(join(ROOT, 'LICENSE-RC.md'))
  const exportManifest = JSON.parse(readFileSync(join(
    ROOT,
    'runtime/rc1/export-manifest.json',
  ), 'utf8'))
  const checksums = readFileSync(join(ROOT, 'runtime/checksums.txt'), 'utf8')
  assert.equal(
    digest(license),
    '7156f38141cf6c48c73802b181f3e309d9b13db71eb2a2feab0b5f50c1a414cf',
  )
  assert.equal(
    exportManifest.files.find(({ path }) => path === 'LICENSE-RC.md')?.sha256,
    digest(license),
  )
  assert.ok(checksums.includes(
    'fcc820a80fd893eff1500a5c36210affa056623c8a566a0cdd9f8c2a664cb556  revia-1.0.0-rc.1-darwin-arm64.tar.gz',
  ))
  assert.ok(checksums.includes(
    '8680c8df50bec5cd0a6c0e2f421d0ea78e4fd4808cbf437f8c185906bde9eb4d  revia-1.0.0-rc.1-darwin-arm64',
  ))
})

test('current source documentation no longer describes the runtime as closed', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const chinese = readFileSync(join(ROOT, 'README.zh-CN.md'), 'utf8')
  const quickstart = readFileSync(join(ROOT, 'QUICKSTART.md'), 'utf8')
  assert.match(readme, /MPL-2\.0/u)
  assert.match(chinese, /MPL-2\.0/u)
  assert.match(quickstart, /MPL-2\.0/u)
  assert.match(quickstart, /LICENSE-RC\.md/u)
})

test('new source policy contains no personal email or private checkout path', () => {
  for (const path of [
    'LICENSE',
    'LICENSE-PREVIEW-0.1.md',
    'SOURCE-LICENSE.md',
    'CONTRIBUTING.md',
    'README.md',
    'README.zh-CN.md',
    'QUICKSTART.md',
    'NOTICE.md',
  ]) {
    const source = readFileSync(join(ROOT, path), 'utf8')
    assert.doesNotMatch(source, /[A-Za-z0-9._%+-]+@qq\.com/iu, path)
    assert.doesNotMatch(source, /\/Users\/[^/\s]+\/|\/home\/[^/\s]+\//u, path)
  }
})

test('published entry points do not retain the previous repository account', () => {
  for (const path of [
    '.github/ISSUE_TEMPLATE/config.yml',
    'README.md',
    'README.zh-CN.md',
    'QUICKSTART.md',
    'SECURITY.md',
    'bin/revia',
    'bin/revia.ps1',
    'scripts/verify-rc1-release-assets.sh',
    'docs/evidence.md',
  ]) {
    const source = readFileSync(join(ROOT, path), 'utf8')
    assert.doesNotMatch(source, /tangshuang631/iu, path)
    assert.doesNotMatch(source, /[A-Za-z0-9._%+-]+@qq\.com/iu, path)
  }
})

test('source import inventory is explicit, path-safe, and digest-bound', () => {
  const inventory = JSON.parse(readFileSync(
    join(ROOT, 'SOURCE_IMPORT_MANIFEST.json'),
    'utf8',
  ))
  const allowlist = JSON.parse(readFileSync(
    join(ROOT, 'SOURCE_IMPORT_FILES.json'),
    'utf8',
  ))
  assert.equal(inventory.schema, 'revia.source-import@1.0.0')
  assert.equal(allowlist.schema, 'revia.source-import-allowlist@1.0.0')
  assert.equal(inventory.license, 'MPL-2.0')
  assert.ok(Array.isArray(inventory.files) && inventory.files.length > 0)

  const paths = inventory.files.map(({ path }) => path)
  assert.deepEqual(paths, allowlist.files)
  assert.deepEqual(paths, [...new Set(paths)].sort())
  assert.ok(paths.includes('bin/revia'))
  assert.ok(paths.includes('bin/revia.ps1'))
  const rootFiles = new Set([
    '.gitattributes',
    '.gitignore',
    'AGENTS.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'LICENSE-PREVIEW-0.1.md',
    'NOTICE.md',
    'NOTICE-PREVIEW-0.1.md',
    'QUICKSTART.md',
    'README.md',
    'README.zh-CN.md',
    'SECURITY.md',
    'SOURCE-LICENSE.md',
    'package.json',
  ])
  for (const entry of inventory.files) {
    assert.ok(
      rootFiles.has(entry.path)
        || /^(?:\.github\/workflows|bin|doc|docs|examples|experiments|projects|scripts|native|src|test|test-support)\//u.test(entry.path),
      `path outside approved import areas: ${entry.path}`,
    )
    assert.doesNotMatch(entry.path, /(^|\/)(relay|scratch|target|\.git)(\/|$)/u)
    assert.equal(typeof entry.bytes, 'number')
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u)
    const filePath = join(ROOT, entry.path)
    assert.equal(lstatSync(filePath).isFile(), true)
    assert.equal(lstatSync(filePath).isSymbolicLink(), false)
    const bytes = readFileSync(filePath)
    assert.equal(bytes.length, entry.bytes)
    assert.equal(digest(bytes), entry.sha256)
  }
})

test('no personal email or private checkout path occurs in imported source', () => {
  const inventory = JSON.parse(readFileSync(
    join(ROOT, 'SOURCE_IMPORT_MANIFEST.json'),
    'utf8',
  ))
  for (const { path } of inventory.files) {
    const bytes = readFileSync(join(ROOT, path))
    if (!isTextPath(path)) continue
    const source = bytes.toString('utf8')
    assert.doesNotMatch(source, /[A-Za-z0-9._%+-]+@qq\.com/iu, path)
    assert.doesNotMatch(source, /\/Users\/[^/\s"'`]+\/|\/home\/[^/\s"'`]+\//u, path)
    assert.doesNotMatch(source, /tangshuang631\/Re(?!via)/u, path)
    assert.doesNotMatch(source, /api\.cnb\.cool|cnb\.cool\/[^/\s]+\/-\/build/iu, path)
  }
})

test('new source roots contain exactly the files in the import manifest', () => {
  const inventory = JSON.parse(readFileSync(
    join(ROOT, 'SOURCE_IMPORT_MANIFEST.json'),
    'utf8',
  ))
  const declared = new Set(inventory.files.map(({ path }) => path))
  for (const root of ['doc', 'native', 'src', 'test', 'test-support']) {
    for (const path of listFiles(join(ROOT, root), root)) {
      assert.ok(declared.has(path), `unlisted imported file: ${path}`)
    }
    for (const path of declared) {
      if (path.startsWith(`${root}/`)) {
        assert.ok(
          listFiles(join(ROOT, root), root).includes(path),
          `missing imported file: ${path}`,
        )
      }
    }
  }
})

function listFiles(absolute, relative) {
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ['node_modules', 'scratch', 'target'].includes(entry.name)) {
      return []
    }
    const child = join(absolute, entry.name)
    const childRelative = `${relative}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${childRelative}`)
    if (entry.isDirectory()) return listFiles(child, childRelative)
    if (!entry.isFile()) throw new Error(`non-regular file is forbidden: ${childRelative}`)
    return [childRelative]
  }).sort()
}

function isTextPath(path) {
  return /\.(?:c|h|js|json|md|ps1|re|rs|sh|toml|txt|yml|yaml)$/iu.test(path)
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// `docs/rc1-license-and-limitations.md` calls itself an operational summary of
// LICENSE-RC.md, but nothing compared the summary to the controlling terms: a
// restriction could be dropped from the page while the license kept it, and a
// reader deciding whether an evaluation use is allowed would not see it.
test('the RC1 license summary lists every restriction the license states', () => {
  const license = readFileSync(join(ROOT, 'LICENSE-RC.md'), 'utf8')
  const restrictions = [...license
    .split('## 2. Restrictions')[1]
    .split(/\n## /u)[0]
    .matchAll(/^\d+\. (.+)$/gmu)]
    .map(([, text]) => text.toLowerCase())
  assert.equal(restrictions.length, 7)

  const page = readFileSync(
    join(ROOT, 'docs', 'rc1-license-and-limitations.md'),
    'utf8',
  )
  const section = page.split('## Not permitted')[1].split(/\n## /u)[0]
  const bullets = []
  for (const line of section.split('\n')) {
    if (line.startsWith('- ')) {
      bullets.push(line.slice(2))
    } else if (/^\s{2}\S/u.test(line) && bullets.length > 0) {
      bullets[bullets.length - 1] += ` ${line.trim()}`
    }
  }
  assert.equal(bullets.length, restrictions.length)
  const summary = bullets.map((bullet) => bullet.toLowerCase())

  // Each numbered restriction keeps a topic that makes it recognizable. A
  // reworded license fails here so the summary moves with it, rather than
  // staying green against a stale topic.
  const TOPICS = [
    'production',
    'sell',
    'redistribut',
    'reverse',
    'notices',
    'technical controls',
    'names or marks',
  ]
  assert.equal(TOPICS.length, restrictions.length)
  restrictions.forEach((text, index) => {
    const topic = TOPICS[index]
    assert.ok(
      text.includes(topic),
      `license restriction ${index + 1} no longer covers "${topic}"`,
    )
    assert.ok(
      summary[index].includes(topic),
      `the summary omits restriction ${index + 1} ("${topic}")`,
    )
  })

  // The page also carries a Chinese one-line abstract of the same list, and it
  // drifts on its own: a reader of the abstract alone must not see a shorter
  // set of prohibited uses than a reader of the English bullets.
  const abstract = page.match(/^> 中文摘要：.*$/mu)?.[0]
  assert.ok(abstract, 'the license page has no Chinese abstract')
  const CJK_TOPICS = ['生产', '商业', '分发', '逆向', '声明', '绕过', '背书']
  assert.equal(CJK_TOPICS.length, restrictions.length)
  CJK_TOPICS.forEach((topic, index) => {
    assert.ok(
      abstract.includes(topic),
      `the Chinese abstract omits restriction ${index + 1} ("${topic}")`,
    )
  })
})

// The sealed RC1 export manifest is the record that shipped with the release.
// Six of its entries are files the public tree still carries, but only
// LICENSE-RC.md was checked against its digest: a renamed or edited record
// would leave the sealed manifest describing a file that is no longer here.
test('the sealed RC1 export agrees with the records the tree still ships', () => {
  const exportManifest = JSON.parse(readFileSync(join(
    ROOT,
    'runtime/rc1/export-manifest.json',
  ), 'utf8'))
  const shipped = [
    'candidate-manifest.json',
    'capability-evidence.json',
    'multi-module-evidence.json',
    'native-evidence.json',
    'server-evidence.json',
    'target-matrix.json',
  ]
  const entries = new Map(exportManifest.files.map((entry) => [entry.path, entry]))
  for (const path of shipped) {
    const entry = entries.get(path)
    assert.ok(entry, `the sealed export no longer lists ${path}`)
    const contents = readFileSync(join(ROOT, 'runtime/rc1', path))
    assert.equal(entry.size, contents.length, `${path} changed size`)
    assert.equal(entry.sha256, digest(contents), `${path} changed contents`)
  }
})

// The sealed export carries the license digest twice: once in the payload
// inventory and once as the top-level `license_sha256`. Only the inventory
// entry was compared with the shipped license, so the top-level field could
// name a stale digest while every other check stayed green.
test('the sealed RC1 export names one license digest', () => {
  const exportManifest = JSON.parse(readFileSync(join(
    ROOT,
    'runtime/rc1/export-manifest.json',
  ), 'utf8'))
  const license = readFileSync(join(ROOT, 'LICENSE-RC.md'))
  const entry = exportManifest.files.find(({ path }) => path === 'LICENSE-RC.md')
  assert.ok(entry, 'the sealed export no longer lists LICENSE-RC.md')
  assert.equal(exportManifest.license_sha256, digest(license))
  assert.equal(exportManifest.license_sha256, entry.sha256)
})

// The allowlist decides what the source-import manifest covers. A tracked
// script that never reaches the allowlist is invisible to the manifest, so
// its provenance can change without any digest moving — that happened to
// `scripts/validate-release-provenance.mjs`, which release-gate CI runs.
// Every tracked JavaScript module has to be listed.
test('every tracked JavaScript module is in the source import allowlist', () => {
  const allowlist = JSON.parse(readFileSync(
    join(ROOT, 'SOURCE_IMPORT_FILES.json'),
    'utf8',
  ))
  const listed = new Set(allowlist.files)
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(tracked.status, 0, tracked.stderr)
  const modules = tracked.stdout
    .split('\n')
    .filter((path) => /\.(?:c|m)?js$/u.test(path))
  assert.ok(modules.length >= 300, `expected the module tree, found ${modules.length}`)
  const missing = modules.filter((path) => !listed.has(path))
  assert.deepEqual(missing, [], `tracked modules outside the allowlist: ${missing.join(', ')}`)
})

// `docs/work-packages/availability.md` keeps the sequencing ledger that every
// work package appends to. The ledger is edited by hand at the end, and none of
// the document scans look at it (`docs/work-packages/` is excluded from the
// command and link checks). A skipped or reused number makes two packages
// indistinguishable in review, so the numbering has to be contiguous and
// unique inside the section that holds it.
test('the work package ledger numbers its entries without gaps', () => {
  const ledger = readFileSync(
    join(ROOT, 'docs/work-packages/availability.md'),
    'utf8',
  )
  const heading = /^## 7\. Sequencing$/mu.exec(ledger)
  assert.ok(heading, 'the sequencing section is gone')
  const rest = ledger.slice(heading.index + heading[0].length)
  const end = rest.search(/^## /mu)
  const section = end === -1 ? rest : rest.slice(0, end)
  const numbers = [...section.matchAll(/^(\d+)\. /gmu)].map((match) => Number(match[1]))
  assert.ok(numbers.length >= 100, `expected the ledger, found ${numbers.length} entries`)
  assert.deepEqual(
    numbers,
    numbers.map((_, index) => index + 1),
    'ledger entries are numbered 1..N in order, once each',
  )
  const last = section.slice(section.lastIndexOf(`\n${numbers.at(-1)}. `))
  assert.ok(last.trim().split('\n').length >= 2, 'the last entry carries its evidence')
})

// A tracked shell script that cannot be parsed is a broken gate: the release
// checks and the trial contract scripts are read by maintainers, and a typo in
// one of them only shows up when that particular gate is invoked. Only a few
// scripts are checked at run time (`scripts/validate-public-tree.sh` parses a
// subset), so the syntax check has to come from the tracked tree itself.
test('every tracked shell script parses before it ships', () => {
  const tracked = spawnSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(tracked.status, 0, tracked.stderr)
  const scripts = tracked.stdout.split('\n').filter((path) => path !== '')
  assert.ok(scripts.length >= 12, `expected the tracked scripts, found ${scripts.length}`)
  const failures = []
  for (const script of scripts) {
    const parsed = spawnSync('sh', ['-n', script], { cwd: ROOT, encoding: 'utf8' })
    if (parsed.status !== 0) failures.push(`${script}: ${parsed.stderr.trim()}`)
  }
  assert.deepEqual(failures, [], 'tracked shell scripts parse with sh -n')
})

// The shipped records and fixtures are read one by one: a release test parses
// the records it knows about, a corpus test parses its own fixture. A tracked
// JSON file that no test happens to open can lose its closing brace or keep a
// trailing comma and the suite stays green until a reader hits it.
test('every tracked JSON file parses before it ships', () => {
  const tracked = spawnSync('git', ['ls-files', '*.json'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(tracked.status, 0, tracked.stderr)
  const files = tracked.stdout
    .split('\n')
    .filter((path) => path !== '' && !path.startsWith('native/'))
  assert.ok(files.length >= 100, `expected the tracked JSON files, found ${files.length}`)
  const failures = []
  for (const path of files) {
    try {
      JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
    } catch (error) {
      failures.push(`${path}: ${error.message}`)
    }
  }
  assert.deepEqual(failures, [], 'tracked JSON files parse')
})
