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
