import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  readFileSync,
  readdirSync,
  lstatSync,
} from 'node:fs'
import { join } from 'node:path'
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
    '8680c8df50bec5cd0a6c2e0f421d0ea78e4fd4808cbf437f8c185906bde9eb4d  revia-1.0.0-rc.1-darwin-arm64',
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
        || /^(?:\.github\/workflows|doc|docs|examples|experiments|projects|scripts|native|src|test|test-support)\//u.test(entry.path),
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
