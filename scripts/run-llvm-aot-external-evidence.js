#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import {
  agentProjectReleaseLockDigest,
} from '../src/runtime/backend-contract.js'
import { RELEASE_TOOLCHAIN_PATHS } from '../src/runtime/release-toolchain-inventory.js'
import { digestTrackedFiles } from '../src/runtime/release-evidence.js'
import { checkSource } from '../src/toolchain/demo-toolchain.js'
import {
  runLlvmAotExternalEvidence,
} from '../src/toolchain/llvm-aot-external-evidence.js'

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('llvm-aot-external-runner-environment-unsupported')
  }
  const lock = await readJson('../release/agent-project-release-lock.json')
  const bundle = await readJson('../test/fixtures/portable-conformance.json')
  const actualToolchainDigest = await digestTrackedFiles(
    await Promise.all(RELEASE_TOOLCHAIN_PATHS.map(async (path) => ({
      path,
      bytes: await readFile(new URL(`../${path}`, import.meta.url)),
    }))),
  )
  if (actualToolchainDigest !== lock.toolchain.digest) {
    fail('llvm-aot-external-toolchain-digest-mismatch')
  }
  const report = await runLlvmAotExternalEvidence({
    bundle,
    compiler_path: '/usr/bin/clang',
    loadGraph,
    release_lock_digest: agentProjectReleaseLockDigest(lock),
    samples: 5,
    target_triple: 'arm64-apple-darwin',
    toolchain_digest: lock.toolchain.digest,
  })
  if (!report.ok) fail(report.diagnostics[0].code)
  await writeFile(
    new URL('../release/llvm-aot-external-evidence.json', import.meta.url),
    `${JSON.stringify(report.value, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${JSON.stringify({
    candidate: report.value.candidate,
    evidence_digest: report.value.evidence_digest,
    stable_digest: report.value.stable_digest,
    status: report.value.status,
    workloads: report.value.workloads.length,
  })}\n`)
} catch (error) {
  process.stderr.write(`${error?.code ?? 'llvm-aot-external-runner-failed'}\n`)
  process.exitCode = 1
}

async function loadGraph(entry) {
  const source = await readFile(
    new URL(`../${entry.graph}`, import.meta.url),
    'utf8',
  )
  const checked = checkSource(source, { file: entry.graph })
  if (!checked.ok) fail(checked.diagnostics[0].code)
  return { ...checked.program, graph_revision: entry.graph_revision }
}

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
