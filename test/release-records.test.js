import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repository = new URL('../', import.meta.url)

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, repository), 'utf8'))
}

const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/u

function digestOf(value) {
  assert.equal(typeof value, 'string')
  assert.match(value, DIGEST)
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value
}

const version = (await readFile(new URL('VERSION', repository), 'utf8')).split('\n')[0].trim()
const metadata = await readJson('runtime/build-metadata.json')
const candidate = await readJson(metadata.candidate_manifest)
const exportManifest = await readJson('runtime/rc2.2.1/export-manifest.json')
const evidence = {
  'linux-x64': await readJson('runtime/rc2.2.1/linux-native-evidence.json'),
  'windows-x64': await readJson('runtime/rc2.2.1/windows-native-evidence.json'),
}

test('the release record names the version in VERSION once, consistently', () => {
  assert.equal(metadata.release, `Revia ${version}`)
  assert.equal(candidate.version, version)
  assert.equal(candidate.release_version, version)
  assert.equal(exportManifest.version, version)
  assert.equal(exportManifest.tag, `v${version}`)
})

test('every build record agrees with the candidate manifest', () => {
  const builds = new Map(metadata.builds.map((build) => [build.target, build]))
  assert.deepEqual(
    [...builds.keys()].sort(),
    candidate.targets.map((target) => target.target).sort(),
  )
  for (const target of candidate.targets) {
    const build = builds.get(target.target)
    assert.equal(build.status, 'measured-native')
    assert.equal(build.source_commit, candidate.source_commit)
    assert.equal(
      digestOf(build.source_inventory_digest),
      digestOf(candidate.source_inventory_digest),
    )
    assert.equal(digestOf(build.archive_sha256), digestOf(target.archive_sha256))
    assert.equal(digestOf(build.binary_sha256), digestOf(target.binary_sha256))
  }
})

test('native evidence records the artifacts the candidate manifest ships', () => {
  for (const target of candidate.targets) {
    const record = evidence[target.target]
    assert.equal(record.version, candidate.version)
    assert.equal(record.target, target.target)
    assert.equal(record.status, 'measured-native')
    assert.equal(record.source_commit, candidate.source_commit)
    assert.equal(
      digestOf(record.source_inventory_digest),
      digestOf(candidate.source_inventory_digest),
    )
    assert.equal(digestOf(record.archive_sha256), digestOf(target.archive_sha256))
    assert.equal(digestOf(record.binary_sha256), digestOf(target.binary_sha256))
  }
})

test('the export manifest carries the same source record and shipped archives', () => {
  assert.equal(exportManifest.status, 'measured-native')
  assert.equal(exportManifest.source_commit, candidate.source_commit)
  assert.equal(
    digestOf(exportManifest.source_inventory_digest),
    digestOf(candidate.source_inventory_digest),
  )
  assert.deepEqual(
    [...exportManifest.targets].sort(),
    candidate.targets.map((target) => target.target).sort(),
  )
  const files = new Map(exportManifest.files.map((file) => [file.path, file]))
  for (const target of candidate.targets) {
    const file = files.get(target.archive)
    assert.ok(file, `export manifest is missing ${target.archive}`)
    assert.equal(digestOf(file.sha256), digestOf(target.archive_sha256))
  }
  const checksums = files.get('checksums.txt')
  assert.ok(checksums, 'export manifest is missing checksums.txt')
  assert.match(checksums.sha256, /^sha256:[0-9a-f]{64}$/u)
})
// The candidate manifest and the public export are written by different
// steps: the export lists what users download, the candidate lists what was
// measured. Nothing compared their archives, so an export could ship one
// measured target and omit another while every record still claimed both.
test('the public export ships the artifacts the candidate lists', () => {
  assert.deepEqual(
    [...exportManifest.targets].sort(),
    candidate.targets.map((target) => target.target).sort(),
  )
  for (const target of candidate.targets) {
    const archive = exportManifest.files.find(
      (file) =>
        file.path.endsWith(`-${target.target}.tar.gz`) ||
        file.path.endsWith(`-${target.target}.zip`),
    )
    assert.ok(archive, `the export does not ship a ${target.target} archive`)
    assert.equal(digestOf(archive.sha256), digestOf(target.archive_sha256))
    assert.ok(Number.isInteger(archive.size) && archive.size > 0)
  }
})

// `runtime/checksums.txt` is the plain digest list readers check a download
// against. Only the RC1 lines and the export manifest's listing were covered,
// so the current candidate could ship a stale or misspelled digest line.
test('runtime checksums name the candidate archives and binaries', async () => {
  const lines = (await readFile(new URL('runtime/checksums.txt', repository), 'utf8'))
    .trim()
    .split('\n')
  const sums = new Map()
  for (const line of lines) {
    const [sum, name] = line.split(/\s+/u)
    assert.match(sum, /^[0-9a-f]{64}$/u, `checksums.txt has a malformed digest: ${line}`)
    assert.ok(name, `checksums.txt has a digest without a file name: ${line}`)
    assert.equal(sums.has(name), false, `checksums.txt repeats ${name}`)
    sums.set(name, sum)
  }
  assert.equal(sums.size, lines.length, 'checksums.txt repeats a line')
  for (const target of candidate.targets) {
    assert.equal(sums.get(target.archive), digestOf(target.archive_sha256), `${target.target} archive`)
    assert.equal(sums.get(target.binary), digestOf(target.binary_sha256), `${target.target} binary`)
  }
  for (const name of sums.keys()) {
    const recorded = name.includes('-rc.1-')
      || candidate.targets.some((target) => target.archive === name || target.binary === name)
    assert.ok(recorded, `checksums.txt lists ${name} for no release record`)
  }
})

// The RC1 lines in `runtime/checksums.txt` were only whitelisted by name, and
// the sealed export's archive entry was never compared with them: the two
// records that describe the same download could disagree while both tests
// passed.
test('the RC1 checksum lines restate the sealed export and candidate digests', async () => {
  const lines = (await readFile(new URL('runtime/checksums.txt', repository), 'utf8'))
    .trim()
    .split('\n')
  const sums = new Map(lines.map((line) => {
    const [sum, name] = line.split(/\s+/u)
    return [name, sum]
  }))
  const candidate = await readJson('runtime/rc1/candidate-manifest.json')
  const sealed = await readJson('runtime/rc1/export-manifest.json')
  const archive = `revia-${candidate.version}-darwin-arm64.tar.gz`
  const binary = `revia-${candidate.version}-darwin-arm64`

  const runner = candidate.files.find((file) => file.path === 'revia')
  assert.ok(runner, 'the RC1 candidate no longer lists the executable')
  assert.equal(sums.get(binary), runner.digest.replace(/^sha256:/u, ''), 'the RC1 binary digest moved')

  const shipped = sealed.files.find((entry) => entry.path === archive)
  assert.ok(shipped, `the sealed export no longer lists ${archive}`)
  assert.equal(sums.get(archive), shipped.sha256, 'the RC1 archive digest moved')
})

// `runtime/rc2.2.1/target-matrix.json` publishes the desktop targets for the
// current release, but only its pending-row count was read: the version field
// was compared with nothing, and a measured row could name a target the
// candidate does not ship while every other record stayed green.
test('the current target matrix names the release it measures', async () => {
  const matrix = await readJson('runtime/rc2.2.1/target-matrix.json')
  const rc1 = await readJson('runtime/rc1/target-matrix.json')
  assert.equal(matrix.schema, 'revia.public-target-matrix@1.0.0')
  assert.equal(matrix.version, candidate.version)
  assert.deepEqual(
    matrix.targets.map((row) => row.target).sort(),
    rc1.targets.map((row) => row.target).sort(),
    'the target matrix no longer carries the desktop targets',
  )
  const measured = matrix.targets
    .filter((row) => row.status === 'measured-native')
    .map((row) => row.target)
  assert.deepEqual(
    measured.sort(),
    candidate.targets.map((target) => target.target).sort(),
    'the matrix measures targets the candidate does not ship',
  )
  for (const row of matrix.targets) {
    assert.ok(
      row.status === 'measured-native' || row.status === 'pending',
      `the matrix records an unknown status for ${row.target}`,
    )
  }
})
