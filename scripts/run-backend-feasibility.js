#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import {
  agentProjectReleaseLockDigest,
} from '../src/runtime/backend-contract.js'
import { RELEASE_TOOLCHAIN_PATHS } from '../src/runtime/release-toolchain-inventory.js'
import { digestTrackedFiles } from '../src/runtime/release-evidence.js'
import {
  createBackendFeasibilityReport,
  verifyBackendFeasibilityReport,
} from '../src/toolchain/backend-feasibility.js'
import {
  llvmAotFeasibilityObservations,
  verifyLlvmAotExternalEvidence,
} from '../src/toolchain/llvm-aot-external-evidence.js'
import { checkSource } from '../src/toolchain/demo-toolchain.js'

try {
  const lock = await readJson('../release/agent-project-release-lock.json')
  const actualToolchainDigest = await digestTrackedFiles(
    await Promise.all(RELEASE_TOOLCHAIN_PATHS.map(async (path) => ({
      path,
      bytes: await readFile(new URL(`../${path}`, import.meta.url)),
    }))),
  )
  if (actualToolchainDigest !== lock.toolchain.digest) {
    fail('backend-feasibility-toolchain-digest-mismatch')
  }
  const bundle = await readJson('../test/fixtures/portable-conformance.json')
  const llvmEvidence = await readJson(
    '../release/llvm-aot-external-evidence.json',
  )
  const llvmVerified = await verifyLlvmAotExternalEvidence(llvmEvidence, {
    bundle,
    loadGraph,
    release_lock_digest: agentProjectReleaseLockDigest(lock),
    toolchain_digest: lock.toolchain.digest,
  })
  if (!llvmVerified.ok) fail(llvmVerified.diagnostics[0].code)

  const reportResult = createBackendFeasibilityReport({
    graph_revision: lock.graph_revision,
    observations: llvmAotFeasibilityObservations(llvmEvidence),
    release_lock_digest: agentProjectReleaseLockDigest(lock),
    toolchain_digest: lock.toolchain.digest,
  })
  if (!reportResult.ok) fail(reportResult.diagnostics[0].code)

  const verified = verifyBackendFeasibilityReport(reportResult.value, {
    graph_revision: lock.graph_revision,
    release_lock_digest: agentProjectReleaseLockDigest(lock),
    toolchain_digest: lock.toolchain.digest,
  })
  if (!verified.ok) fail(verified.diagnostics[0].code)

  await writeFile(
    new URL('../release/backend-feasibility-report.json', import.meta.url),
    `${JSON.stringify(reportResult.value, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${JSON.stringify({
    candidates: reportResult.value.candidates.map(({ candidate, status }) => ({
      candidate,
      status,
    })),
    report_digest: reportResult.value.report_digest,
    schema: reportResult.value.schema,
    status: reportResult.value.status,
  })}\n`)
} catch (error) {
  process.stderr.write(`${error?.code ?? 'backend-feasibility-runner-failed'}\n`)
  process.exitCode = 1
}

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
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

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
