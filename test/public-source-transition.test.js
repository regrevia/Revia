import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
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

// The test above compares the manifest with the bytes on disk, and the index
// compares the bytes on disk with a cached (size, mtime) pair. Neither reads the
// commit, so a rewrite that keeps both is invisible to each of them: `git
// status` reports the tree clean while the manifest and the commit are the two
// that disagree. That happened for real — a 358610-byte
// `native/revia-cli/src/main.rs` had one line spliced into a non-compiling
// `fn same_file(...) -> bool {, So false` and still reported clean, with the
// length and the modification time the index had cached still describing the
// committed file. How it got there is not known and not claimed here; what is
// measured is that nothing in the gate could have said so. `git checkout -- <path>` does not
// repair it either: it skips a file it believes is already up to date, so the
// file came back byte-identical to the corruption. The repair is
// `git cat-file blob HEAD:<path> > <path>`.
//
// This asks the one pair that trusts no cache: what Git would store for the file
// now, against what the commit holds. A path Git reports as pending is skipped,
// because a `--refresh` that has not been committed yet is ahead of HEAD on
// purpose rather than drifted from it.
test('the import manifest describes the commit, not the stat cache', () => {
  const inventory = JSON.parse(readFileSync(
    join(ROOT, 'SOURCE_IMPORT_MANIFEST.json'),
    'utf8',
  ))
  const tree = spawnSync('git', ['ls-tree', '-r', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(tree.status, 0, tree.stderr)
  const committed = new Map()
  for (const line of tree.stdout.split('\n')) {
    if (line === '') continue
    const [metadata, path] = line.split('\t')
    committed.set(path, metadata.split(' ')[2])
  }
  const status = spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  assert.equal(status.status, 0, status.stderr)
  // A rename is one porcelain line naming both sides, so both are pending.
  const pending = new Set()
  for (const line of status.stdout.split('\n')) {
    if (line === '') continue
    for (const path of line.slice(3).split(' -> ')) pending.add(path)
  }
  // A manifest path that is missing from the tree is the digest test's finding,
  // not this one's: it reads the file and fails there rather than here.
  const asked = inventory.files
    .map(({ path }) => path)
    .filter((path) => !pending.has(path) && existsSync(join(ROOT, path)))
  assert.ok(asked.length >= 700, `expected the import set, found ${asked.length}`)
  const hashed = spawnSync('git', ['hash-object', '--stdin-paths'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: `${asked.join('\n')}\n`,
  })
  assert.equal(hashed.status, 0, hashed.stderr)
  const onDisk = hashed.stdout.split('\n')
  const drifted = asked.filter((path, index) => committed.get(path) !== onDisk[index])
  assert.deepEqual(
    drifted,
    [],
    'files Git calls unchanged disagree with the commit; restore each with '
      + '`git cat-file blob HEAD:<path> > <path>`, because `git checkout -- <path>` '
      + 'skips a file its stat cache believes is up to date',
  )
})

// The test above measures one commit — HEAD — against the worktree. Nothing
// measured the commits themselves: a commit that carries a drifted file *and*
// the manifest that absorbed it is self-consistent, so the pair above passes on
// it and only a reader of the commit diff can tell. That happened for real,
// thirteen times, before the drift test existed. The rows below are what a walk
// of this repository's whole history finds, written down so the walk can be
// strict about every commit that comes after them instead of quiet about all of
// them.
//
// Each row is one (commit, path) pair where that commit's own
// `SOURCE_IMPORT_MANIFEST.json` pins a digest the commit's own tree does not
// store, because the manifest was not regenerated in the commit that changed
// the file. None is repaired here: rewriting published history to turn a test
// green is a worse answer than naming it, and the handover brief carries them as
// an open defect. The walk reads every commit rather than a recent window,
// because a window is a rule about where drift is allowed to hide and the
// nearest row is 246 commits back. It costs about a third of a second here and
// needs history, so a shallow clone skips with its reason rather than reporting
// a history it never read.
const LANDED_SKEW = [
  // commit, path, the digest that commit's manifest pinned, the digest it stored
  ['33ab7209365a8f7bf63783f1cd8a4e543b0a7e20', 'native/revia-cli/tests/wp4_result_value_cli.rs',
    '4b4f1439c89e29a61a7338c5b8d34018a8f5b233abdbb8865cd729f2501240a7',
    'ba3b27079b42e37d3e822bfb59470e308e727acfe98d1bc8cbba80cf94ec2ea8'],
  ['326d579da1ccfd54134708cbc1c487ae690aa54c', 'native/revia-core/src/project.rs',
    '35210d860deb5cf7d1f7ad4f34f4d66531b1c987fdb01930e37bed992b1e95c7',
    '398667d6acf208f5e87b791295e6353bc10b9142e1cdb81e6316477dac01c65d'],
  ['3a7c099152210f5556f0cb748547bcee515fd53b', 'native/Cargo.toml',
    '85ca4d54fa47f3bd164d3b3d035400ce6982d58f349c458e60dcdf0d58294850',
    '54785e25c98a283b5a2e4dc1f8f4c163da8398dbc77d3ed14efb448d62310059'],
  ['f7994f586c5ac191ab8f7a065879b5781541e833', 'native/Cargo.lock',
    '938bb8e57c7ef13dfb04634288fe223c755ee84050deae6c7d6e922b5d0f30e8',
    '95c8d14f504a6f224bff1331dc2aa30328244107d304693dafa825b59e0d7359'],
  ['f7994f586c5ac191ab8f7a065879b5781541e833', 'native/Cargo.toml',
    '85ca4d54fa47f3bd164d3b3d035400ce6982d58f349c458e60dcdf0d58294850',
    'be421f1c5efb35822b82128e5fa24456d51ea19f408a1cc49b3a8b3bb17d6c1c'],
  ['f7994f586c5ac191ab8f7a065879b5781541e833', 'native/revia-cli/src/main.rs',
    'dabdebc8652d8f0bbcf5fbeeb6a78cfcc13e96885ba6dd2ff1a1ca2f4029f9b7',
    '11e4a97bf6b11d2aec71403277e782d886202f82dc54c8914cec69dc4f3b59f3'],
  ['f7994f586c5ac191ab8f7a065879b5781541e833', 'native/revia-cli/tests/wp285_cli_help.rs',
    '8094a7807be8ae7a0d16db5ea99845318cb2867db78c77a8d22696c7aa090f08',
    '525727a0f8076767c19df5f41ac56e2bb60573ad910f0870b36f79c70651bdc8'],
  ['f7994f586c5ac191ab8f7a065879b5781541e833', 'native/revia-core/src/release.rs',
    'eea86539fd2a3235d6dac1456a8a78a1e5d65fb7d32a18e398e39cedba5c87fb',
    '8360f86cb4fe5cc8d0473c8728dd3f7793b6354aa0042724110d18d1ee950edb'],
  ['f7994f586c5ac191ab8f7a065879b5781541e833', 'native/revia-core/tests/wp263_native_release.rs',
    'bb939e3ba320a17e396a093f374939a747fa28297fccb7236d123234e93a6a0e',
    'e8e7ae15fdd747f4cfbb4d706a4325f9e5019a143d3f04b7a0f0af68bb9b0b10'],
  ['f7994f586c5ac191ab8f7a065879b5781541e833', 'native/revia-core/tests/wp304_rc2_release_identity.rs',
    'ac709b4276790d5b050f97bab7e8bd0e3618e7794e2d676e9c264c9e38baa1b0',
    '8208b71d83e4ad58c765683e0666fe8cb25d3340b9c176136d557518334f538f'],
  ['ef8b6def3d2d47a6050c79f5450d342243c20996', 'native/revia-cli/tests/wp295_native_capability_release_evidence_cli.rs',
    'd1a89c453e7c4529b06e0d99f2517d8e74893e82d1a875ea2575df3f19f4c521',
    '3bc9b3310201b20ad8cde6fbe8cfcb7907269d662542049da6518c6acc9fd33e'],
  ['a842c1ef5de95f5fa7ca57f74b6b21615c70859f', 'native/revia-cli/tests/wp283_release_evidence_cli.rs',
    '39a025e27e3a5d853945966557c63841dc87717de2545d403d5d2579862191f0',
    'ca7a55b63be5dd29cf34719ee7899a1093ce012c51d7f7d38fbac50985a6dcd8'],
  ['31e17310cfcadef55656bd83f25e069e44e087db', 'native/revia-cli/tests/wp259_server_cli.rs',
    '830e1858beda30c57d149f3d76e7de0d3e9da1c5a296c59dab5a2b865743b1db',
    '8d1e573a3e5efebd7fa1545429287f4fc2b36672bd768b8b43f762724926e840'],
]

test('no commit publishes a file its own import manifest disagrees with', (t) => {
  const shallow = spawnSync(
    'git',
    ['rev-parse', '--is-shallow-repository'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  assert.equal(shallow.status, 0, shallow.stderr)
  if (shallow.stdout.trim() === 'true') {
    // A one-commit clone would report every history as clean, which is the
    // false green this test exists to remove. The Node job in
    // `.github/workflows/validate.yml` checks out full history for it.
    t.skip('shallow clone: no history to compare, so this run measured the worktree only')
    return
  }

  const commits = text(['rev-list', 'HEAD']).trim().split('\n')
  assert.ok(commits.length > 300, `expected the full history, found ${commits.length} commits`)

  // One batch read answers "what did this commit's manifest pin" for every
  // commit, including the ones that predate the manifest.
  const manifests = new Map()
  const pinned = blobs(commits.map((commit) => `${commit}:SOURCE_IMPORT_MANIFEST.json`))
  commits.forEach((commit, index) => {
    const body = pinned.get(`${commit}:SOURCE_IMPORT_MANIFEST.json`)
    if (body !== undefined) manifests.set(commit, JSON.parse(body))
  })
  assert.ok(
    manifests.size > 300,
    `expected most commits to carry an import manifest, found ${manifests.size}`,
  )

  // `--raw` names the before and after blob of every path in every commit, so
  // the walk reads the commit itself rather than anything the working tree says.
  const changed = []
  let commit = null
  let pins = null
  for (const line of text(['log', '--raw', '--no-renames', '--no-abbrev', '--format=C %H', 'HEAD'])
    .split('\n')) {
    if (line.startsWith('C ')) {
      commit = line.slice(2).trim()
      const manifest = manifests.get(commit)
      pins = manifest === undefined
        ? null
        : new Map(manifest.files.map(({ path, sha256 }) => [path, sha256]))
      continue
    }
    if (!line.startsWith(':') || pins === null) continue
    const [metadata, path] = line.split('\t')
    const [, , before, after] = metadata.slice(1).split(' ')
    // A deletion stores nothing, and its pinned entry is already gone, so it is
    // the digest test's finding rather than this one's.
    if (after === '0'.repeat(40) || before === after || !pins.has(path)) continue
    changed.push({ commit, path, after, pinned: pins.get(path) })
  }
  assert.ok(changed.length >= 1_000, `expected the published diff, found ${changed.length} paths`)

  const stored = blobs([...new Set(changed.map(({ after }) => after))])
  const observed = []
  for (const { commit, path, after, pinned: expected } of changed) {
    const bytes = stored.get(after)
    assert.ok(bytes !== undefined, `git did not hand back blob ${after}`)
    const actual = digest(bytes)
    if (actual !== expected) observed.push([commit, path, expected, actual])
  }

  // Both directions matter. A pair this walk no longer finds is a row that has
  // gone stale — a rewritten commit, a wrong digest written down, an unread
  // path — and a test that only counted new violations would hide that.
  const key = (row) => row.join(' ')
  const known = new Set(LANDED_SKEW.map(key))
  const found = new Set(observed.map(key))
  assert.deepEqual(
    observed.filter((row) => !known.has(key(row))).map(key),
    [],
    'a commit stores bytes its own import manifest pins to a different digest; rebuild the '
      + 'manifest in that commit (`npm run source:manifest:write`) instead of adding it here',
  )
  assert.deepEqual(
    LANDED_SKEW.filter((row) => !found.has(key(row))).map(key),
    [],
    'this table names a drift that history no longer shows; delete the stale row rather than '
      + 'leaving a claim that cannot be walked',
  )
})

function text(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

// `cat-file --batch` answers many object reads in one process; asking once per
// blob would spawn a Git per path and make a history walk too slow to keep.
// A name that is not there answers `missing` on one line, with no body after it.
function blobs(names) {
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    input: `${names.join('\n')}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  })
  assert.equal(result.status, 0, String(result.stderr))
  const answer = new Map()
  const out = result.stdout
  let offset = 0
  let index = 0
  while (offset < out.length) {
    const newline = out.indexOf(0x0a, offset)
    const header = out.subarray(offset, newline).toString('utf8')
    offset = newline + 1
    if (header.endsWith(' missing')) {
      index += 1
      continue
    }
    const size = Number(header.split(' ')[2])
    answer.set(names[index], out.subarray(offset, offset + size))
    offset += size + 1
    index += 1
  }
  return answer
}

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
