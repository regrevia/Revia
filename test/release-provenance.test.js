import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

const repository = fileURLToPath(new URL('../', import.meta.url))
const corpus = JSON.parse(await readFile(
  new URL('./fixtures/release-provenance-corpus.json', import.meta.url),
  'utf8',
))

test('release gate validates the draft provenance before publication and rejects the historical tag', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release-gate.yml', import.meta.url),
    'utf8',
  )
  const rejectHistorical = workflow.indexOf('v1.0.0-rc.2.2.1')
  const checkout = workflow.indexOf('actions/checkout@')
  const validate = workflow.indexOf('scripts/validate-release-provenance.mjs')
  const publish = workflow.indexOf('gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --draft=false')

  assert.notEqual(rejectHistorical, -1)
  assert.ok(checkout > rejectHistorical)
  assert.notEqual(validate, -1)
  assert.ok(publish > validate)
  assert.match(workflow.slice(validate, publish), /gh release download/u)
  assert.match(workflow.slice(validate, publish), /--artifact-dir/u)
  assert.match(workflow, /needs: \[provenance, smoke, windows-x64-native\]/u)
  assert.match(workflow, /needs: provenance/u)
})

test('release provenance validator rejects an incomplete command contract', () => {
  const result = spawnSync(process.execPath, [
    join(repository, 'scripts/validate-release-provenance.mjs'),
  ], { cwd: repository, encoding: 'utf8' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /required argument --metadata-path is missing/u)
})

test('release provenance validator enforces clean, malformed, and drifted records', async (context) => {
  for (const entry of corpus.cases) {
    const workspace = await mkdtemp(join(tmpdir(), `re-release-provenance-${entry.id}-`))
    context.after(() => rm(workspace, { force: true, recursive: true }))
    const runtime = join(workspace, 'runtime')
    const candidatePath = join(runtime, 'candidate-manifest.json')
    const artifactDirectory = join(workspace, 'assets')
    await mkdir(runtime, { recursive: true })
    await mkdir(artifactDirectory, { recursive: true })

    const version = '1.0.0-rc.9'
    const tag = `v${version}`
    const sourceCommit = 'b'.repeat(40)
    const inventory = `sha256:${'c'.repeat(64)}`
    const archiveBytes = Buffer.from('release archive bytes')
    const archiveDigest = createHash('sha256').update(archiveBytes).digest('hex')
    const binaryDigest = 'd'.repeat(64)
    const targets = [{
      target: 'linux-x64',
      archive: `revia-${version}-linux-x64.tar.gz`,
      archive_sha256: `sha256:${archiveDigest}`,
      binary: `revia-${version}-linux-x64`,
      binary_sha256: `sha256:${binaryDigest}`,
    }]

    await writeFile(join(artifactDirectory, targets[0].archive), archiveBytes)
    await writeFile(candidatePath, `${JSON.stringify({
      version,
      release_version: version,
      source_commit: sourceCommit,
      source_inventory_digest: inventory,
      targets,
    })}\n`)
    await writeFile(join(runtime, 'export-manifest.json'), `${JSON.stringify({
      version,
      tag,
      status: 'measured-native',
      source_commit: sourceCommit,
      source_inventory_digest: inventory,
      targets: ['linux-x64'],
      files: [{
        path: targets[0].archive,
        sha256: archiveDigest,
        size: archiveBytes.length,
      }],
    })}\n`)
    await writeFile(join(runtime, 'linux-native-evidence.json'), `${JSON.stringify({
      version,
      target: 'linux-x64',
      status: 'measured-native',
      source_commit: sourceCommit,
      source_inventory_digest: inventory,
      archive_sha256: archiveDigest,
      binary_sha256: binaryDigest,
    })}\n`)
    await writeFile(join(runtime, 'checksums.txt'), [
      `${archiveDigest}  ${targets[0].archive}`,
      `${binaryDigest}  ${targets[0].binary}`,
    ].join('\n') + '\n')
    await writeFile(join(workspace, 'build-metadata.json'), `${JSON.stringify({
      release: `Revia ${version}`,
      candidate_manifest: 'runtime/candidate-manifest.json',
      builds: [{
        target: 'linux-x64',
        status: 'measured-native',
        source_commit: sourceCommit,
        source_inventory_digest: inventory,
        archive_sha256: `sha256:${archiveDigest}`,
        binary_sha256: `sha256:${binaryDigest}`,
      }],
    })}\n`)

    if (entry.mutate === 'missing-inventory') {
      const candidate = JSON.parse(await readFile(candidatePath, 'utf8'))
      delete candidate.source_inventory_digest
      await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`)
    } else if (entry.mutate === 'export-inventory') {
      const exportManifest = JSON.parse(await readFile(join(runtime, 'export-manifest.json'), 'utf8'))
      exportManifest.source_inventory_digest = `sha256:${'e'.repeat(64)}`
      await writeFile(join(runtime, 'export-manifest.json'), `${JSON.stringify(exportManifest)}\n`)
    } else if (entry.mutate === 'evidence-inventory') {
      const evidencePath = join(runtime, 'linux-native-evidence.json')
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
      evidence.source_inventory_digest = `sha256:${'e'.repeat(64)}`
      await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`)
    } else if (entry.mutate === 'build-archive') {
      const metadataPath = join(workspace, 'build-metadata.json')
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
      metadata.builds[0].archive_sha256 = `sha256:${'e'.repeat(64)}`
      await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`)
    } else if (entry.mutate === 'checksum-archive') {
      await writeFile(join(runtime, 'checksums.txt'), `eeeeeeee  ${targets[0].archive}\n`)
    } else if (entry.mutate === 'asset-archive') {
      await writeFile(join(artifactDirectory, targets[0].archive), 'replaced archive bytes')
    } else if (entry.mutate === 'missing-asset') {
      await rm(join(artifactDirectory, targets[0].archive))
    } else if (entry.mutate === 'extra-build') {
      const metadataPath = join(workspace, 'build-metadata.json')
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
      metadata.builds.push({ ...metadata.builds[0], target: 'windows-x64' })
      await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`)
    } else if (entry.mutate === 'wrong-tag') {
      const exportManifest = JSON.parse(await readFile(join(runtime, 'export-manifest.json'), 'utf8'))
      exportManifest.tag = 'v1.0.0-rc.2.2.1'
      await writeFile(join(runtime, 'export-manifest.json'), `${JSON.stringify(exportManifest)}\n`)
    }

    const result = spawnSync(process.execPath, [
      join(repository, 'scripts/validate-release-provenance.mjs'),
      '--metadata-path',
      join(workspace, 'build-metadata.json'),
      '--checksums-path',
      join(runtime, 'checksums.txt'),
      '--tag',
      entry.mutate === 'wrong-tag' ? tag : entry.tag ?? tag,
      '--artifact-dir',
      artifactDirectory,
    ], { cwd: workspace, encoding: 'utf8' })
    assert.equal(result.status === 0, entry.status === 'pass', `${entry.id}: ${result.stderr}`)
    if (entry.status === 'pass') {
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: true,
        schema: 're.release-provenance-validation@0.1.0',
        version,
        targets: ['linux-x64'],
      })
    }
  }
})
