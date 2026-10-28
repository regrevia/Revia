import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import {
  agentProjectReleaseLockDigest,
  validateAgentProjectReleaseLock,
} from './backend-contract.js'
import { verifyReleaseSignature } from './release-signature.js'

export async function installRelease({
  artifact,
  installRoot,
  lock,
}) {
  try {
    validateInstallInput(artifact, installRoot, lock)
    const lockDigest = agentProjectReleaseLockDigest(lock)
    const releaseId = lockDigest.slice('sha256:'.length)
    const releasesRoot = join(installRoot, 'releases')
    const releaseRoot = join(releasesRoot, releaseId)
    await mkdir(releasesRoot, { recursive: true })
    let replayed = true
    try {
      await verifyInstalledRelease(releaseRoot, lock, artifact)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      replayed = false
      const staging = join(installRoot, `.release-${releaseId}-${randomUUID()}`)
      try {
        await mkdir(staging)
        await writeFile(join(staging, 'artifact.json'), canonicalJson(artifact))
        await writeFile(join(staging, 'release-lock.json'), canonicalJson(lock))
        await rename(staging, releaseRoot)
      } catch (error_) {
        await rm(staging, { force: true, recursive: true })
        throw error_
      }
    }
    const previous = await readCurrent(installRoot)
    await writeCurrent(installRoot, {
      lock_digest: lockDigest,
      release_id: releaseId,
      schema: 're.installed-release-pointer@0.1.0',
    })
    return {
      ok: true,
      value: {
        current_lock_digest: lockDigest,
        previous_lock_digest: previous?.lock_digest ?? null,
        release_id: releaseId,
        replayed,
        schema: 're.release-install-result@0.1.0',
      },
    }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'release-install-failed',
        reason: error?.message ?? 'unknown-error',
      }],
      ok: false,
    }
  }
}

export async function installSignedRelease({
  artifact,
  installRoot,
  lock,
  now,
  publicKey,
  signature,
}) {
  const verified = verifyReleaseSignature({
    artifact,
    envelope: signature,
    lock,
    now,
    publicKey,
  })
  if (!verified.ok) return verified
  return installRelease({ artifact, installRoot, lock })
}

export async function rollbackRelease({ installRoot, lockDigest }) {
  try {
    if (typeof installRoot !== 'string' || installRoot.length === 0
      || !/^sha256:[0-9a-f]{64}$/u.test(lockDigest)) {
      throw new TypeError('invalid release rollback request')
    }
    const releaseId = lockDigest.slice('sha256:'.length)
    const releaseRoot = join(installRoot, 'releases', releaseId)
    const lock = JSON.parse(await readFile(join(releaseRoot, 'release-lock.json'), 'utf8'))
    const artifact = JSON.parse(await readFile(join(releaseRoot, 'artifact.json'), 'utf8'))
    validateInstallInput(artifact, installRoot, lock)
    if (agentProjectReleaseLockDigest(lock) !== lockDigest) {
      throw new TypeError('installed release lock digest mismatch')
    }
    const previous = await readCurrent(installRoot)
    await writeCurrent(installRoot, {
      lock_digest: lockDigest,
      release_id: releaseId,
      schema: 're.installed-release-pointer@0.1.0',
    })
    return {
      ok: true,
      value: {
        current_lock_digest: lockDigest,
        previous_lock_digest: previous?.lock_digest ?? null,
        release_id: releaseId,
        schema: 're.release-rollback-result@0.1.0',
      },
    }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'release-rollback-failed',
        reason: error?.message ?? 'unknown-error',
      }],
      ok: false,
    }
  }
}

export async function readInstalledRelease(installRoot) {
  const current = await readCurrent(installRoot)
  if (current === null) return null
  const root = join(installRoot, 'releases', current.release_id)
  return {
    artifact: JSON.parse(await readFile(join(root, 'artifact.json'), 'utf8')),
    current,
    lock: JSON.parse(await readFile(join(root, 'release-lock.json'), 'utf8')),
  }
}

async function verifyInstalledRelease(root, lock, artifact) {
  const installedLock = JSON.parse(await readFile(join(root, 'release-lock.json'), 'utf8'))
  const installedArtifact = JSON.parse(await readFile(join(root, 'artifact.json'), 'utf8'))
  if (canonicalJson(installedLock) !== canonicalJson(lock)
    || canonicalJson(installedArtifact) !== canonicalJson(artifact)) {
    throw new TypeError('installed release content mismatch')
  }
}

function validateInstallInput(artifact, installRoot, lock) {
  if (typeof installRoot !== 'string' || installRoot.length === 0
    || lock === null || typeof lock !== 'object' || Array.isArray(lock)
    || artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)
    || canonicalJson(artifact) !== canonicalJson(lock.build_artifact)) {
    throw new TypeError('release lock build artifact mismatch')
  }
  const validated = validateAgentProjectReleaseLock(lock)
  if (!validated.ok) throw new TypeError(validated.diagnostics[0].code)
}

async function readCurrent(installRoot) {
  try {
    const value = JSON.parse(await readFile(join(installRoot, 'current.json'), 'utf8'))
    if (value?.schema !== 're.installed-release-pointer@0.1.0'
      || !/^sha256:[0-9a-f]{64}$/u.test(value.lock_digest)
      || value.release_id !== value.lock_digest.slice('sha256:'.length)) {
      throw new TypeError('invalid installed release pointer')
    }
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function writeCurrent(installRoot, value) {
  await mkdir(installRoot, { recursive: true })
  const temporary = join(installRoot, `.current-${randomUUID()}`)
  try {
    await writeFile(temporary, canonicalJson(value))
    await rename(temporary, join(installRoot, 'current.json'))
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
