import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'

const options = parseArguments(process.argv.slice(2))
const workspace = process.cwd()
const metadataPath = resolve(workspace, options.metadataPath)
const checksumsPath = resolve(workspace, options.checksumsPath)
const artifactDirectory = resolve(workspace, options.artifactDirectory)
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
const candidatePath = resolve(workspace, requiredString(metadata.candidate_manifest))
assert.ok(isWithin(workspace, candidatePath), 'candidate manifest path escapes workspace')
const candidate = JSON.parse(await readFile(candidatePath, 'utf8'))
const releaseRoot = resolve(candidatePath, '..')
const exportManifest = JSON.parse(await readFile(resolve(releaseRoot, 'export-manifest.json'), 'utf8'))

assert.match(options.tag, /^v[0-9][A-Za-z0-9.+-]*$/u)
assert.equal(options.tag, `v${requiredString(candidate.version)}`)
assert.equal(requiredString(candidate.release_version), candidate.version)
assert.equal(requiredString(metadata.release), `Revia ${candidate.version}`)
assert.equal(requiredString(exportManifest.version), candidate.version)
assert.equal(requiredString(exportManifest.tag), options.tag)
assert.equal(requiredString(exportManifest.source_commit), requiredString(candidate.source_commit))
assert.equal(
  requiredDigest(exportManifest.source_inventory_digest),
  requiredDigest(candidate.source_inventory_digest),
)
assert.equal(requiredString(exportManifest.status), 'measured-native')

const targetNames = candidate.targets.map((target) => requiredString(target.target))
assert.ok(targetNames.length > 0, 'candidate has no measured targets')
assert.equal(new Set(targetNames).size, targetNames.length, 'duplicate candidate target')
assert.deepEqual([...exportManifest.targets].sort(), [...targetNames].sort())

const builds = uniqueByTarget(metadata.builds, 'build metadata')
assert.deepEqual([...builds.keys()].sort(), [...targetNames].sort())
for (const target of candidate.targets) {
  const name = target.target
  const build = builds.get(name)
  assert.equal(requiredString(build.status), 'measured-native')
  assert.equal(requiredString(build.source_commit), candidate.source_commit)
  assert.equal(
    requiredDigest(build.source_inventory_digest),
    requiredDigest(candidate.source_inventory_digest),
  )
  assert.equal(requiredDigest(build.archive_sha256), requiredDigest(target.archive_sha256))
  assert.equal(requiredDigest(build.binary_sha256), requiredDigest(target.binary_sha256))
}

const evidenceFiles = (await readdir(releaseRoot))
  .filter((name) => name.endsWith('-native-evidence.json'))
  .sort()
const evidenceByTarget = new Map()
for (const file of evidenceFiles) {
  const evidence = JSON.parse(await readFile(resolve(releaseRoot, file), 'utf8'))
  const target = requiredString(evidence.target)
  assert.ok(!evidenceByTarget.has(target), `duplicate native evidence for ${target}`)
  evidenceByTarget.set(target, evidence)
}
assert.deepEqual([...evidenceByTarget.keys()].sort(), [...targetNames].sort())
for (const target of candidate.targets) {
  const evidence = evidenceByTarget.get(target.target)
  assert.equal(requiredString(evidence.version), candidate.version)
  assert.equal(requiredString(evidence.status), 'measured-native')
  assert.equal(requiredString(evidence.source_commit), candidate.source_commit)
  assert.equal(
    requiredDigest(evidence.source_inventory_digest),
    requiredDigest(candidate.source_inventory_digest),
  )
  assert.equal(requiredDigest(evidence.archive_sha256), requiredDigest(target.archive_sha256))
  assert.equal(requiredDigest(evidence.binary_sha256), requiredDigest(target.binary_sha256))
}

const exportFiles = uniqueByPath(exportManifest.files)
const checksumFiles = parseChecksums(await readFile(checksumsPath, 'utf8'))
const downloadedNames = new Set(await readdir(artifactDirectory))
for (const target of candidate.targets) {
  const archive = requiredString(target.archive)
  assert.equal(archive, basename(archive), 'archive path must be a filename')
  const archiveDigest = requiredDigest(target.archive_sha256)
  const exported = exportFiles.get(archive)
  assert.ok(exported, `export manifest missing ${archive}`)
  assert.equal(requiredDigest(exported.sha256), archiveDigest)
  assert.equal(checksumFiles.get(archive), archiveDigest, `checksum drift for ${archive}`)
  assert.ok(downloadedNames.has(archive), `downloaded release asset missing ${archive}`)
  const bytes = await readFile(resolve(artifactDirectory, archive))
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    archiveDigest,
    `downloaded release asset drift for ${archive}`,
  )

  const binary = requiredString(target.binary)
  assert.equal(binary, basename(binary), 'binary path must be a filename')
  const binaryDigest = requiredDigest(target.binary_sha256)
  assert.equal(checksumFiles.get(binary), binaryDigest, `checksum drift for ${binary}`)
}

console.log(JSON.stringify({
  ok: true,
  schema: 're.release-provenance-validation@0.1.0',
  targets: targetNames,
  version: candidate.version,
}))

function parseArguments(arguments_) {
  const parsed = new Map()
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index]
    const value = arguments_[index + 1]
    assert.ok([
      '--metadata-path',
      '--checksums-path',
      '--tag',
      '--artifact-dir',
    ].includes(flag), `unknown argument ${flag}`)
    assert.ok(value && !value.startsWith('--'), `missing value for ${flag}`)
    assert.ok(!parsed.has(flag), `duplicate argument ${flag}`)
    parsed.set(flag, value)
    index += 1
  }
  for (const required of ['--metadata-path', '--checksums-path', '--tag', '--artifact-dir']) {
    assert.ok(parsed.has(required), `required argument ${required} is missing`)
  }
  return {
    metadataPath: parsed.get('--metadata-path'),
    checksumsPath: parsed.get('--checksums-path'),
    tag: parsed.get('--tag'),
    artifactDirectory: parsed.get('--artifact-dir'),
  }
}

function requiredString(value) {
  assert.equal(typeof value, 'string')
  assert.notEqual(value.trim(), '')
  return value
}

function requiredDigest(value) {
  const digest = requiredString(value).replace(/^sha256:/u, '')
  assert.match(digest, /^[0-9a-f]{64}$/u)
  return digest
}

function uniqueByTarget(records, label) {
  assert.ok(Array.isArray(records), `${label} list missing`)
  const result = new Map()
  for (const record of records) {
    const target = requiredString(record.target)
    assert.ok(!result.has(target), `duplicate ${label} for ${target}`)
    result.set(target, record)
  }
  return result
}

function uniqueByPath(records) {
  assert.ok(Array.isArray(records), 'export file list missing')
  const result = new Map()
  for (const record of records) {
    const path = requiredString(record.path)
    assert.ok(!result.has(path), `duplicate export file ${path}`)
    result.set(path, record)
  }
  return result
}

function parseChecksums(contents) {
  const result = new Map()
  for (const line of contents.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([0-9a-f]{64})  ([^\s]+)$/u.exec(line)
    assert.ok(match, `invalid checksum line: ${line}`)
    assert.ok(!result.has(match[2]), `duplicate checksum for ${match[2]}`)
    result.set(match[2], match[1])
  }
  return result
}

function isWithin(root, path) {
  if (isAbsolute(relative(root, path)) || relative(root, path).startsWith('..')) return false
  return true
}
