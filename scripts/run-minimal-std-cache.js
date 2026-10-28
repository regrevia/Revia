#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RELEASE_TOOLCHAIN_PATHS } from '../src/runtime/release-toolchain-inventory.js'
import { digestTrackedFiles } from '../src/runtime/release-evidence.js'
import {
  runMinimalStdCacheConformance,
  verifyMinimalStdCacheConformance,
} from '../src/toolchain/minimal-std-cache.js'

const root = new URL('../', import.meta.url)
const lock = JSON.parse(await readFile(
  new URL('../release/agent-project-release-lock.json', import.meta.url),
  'utf8',
))
const toolchainDigest = digestTrackedFiles(await Promise.all(
  RELEASE_TOOLCHAIN_PATHS.map(async (path) => ({
    bytes: await readFile(new URL(path, root)),
    path,
  })),
))
if (toolchainDigest !== lock.toolchain.digest) {
  throw new TypeError('release toolchain digest mismatch')
}
const cacheDirectory = await mkdtemp(join(tmpdir(), 're-minimal-std-cache-'))
try {
  const report = await runMinimalStdCacheConformance({
    cacheDirectory,
    moduleCounts: [50, 500],
    profile_digest: lock.profile.digest,
    toolchain_digest: toolchainDigest,
  })
  const verified = verifyMinimalStdCacheConformance(report)
  if (!verified.ok) throw new TypeError(verified.diagnostics[0].code)
  await writeFile(
    new URL('../release/minimal-std-cache-report.json', import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${report.report_digest}\n`)
} finally {
  await rm(cacheDirectory, { force: true, recursive: true })
}
