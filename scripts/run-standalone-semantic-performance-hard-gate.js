#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import {
  agentProjectReleaseLockDigest,
} from '../src/runtime/backend-contract.js'
import { checkSource } from '../src/toolchain/demo-toolchain.js'
import {
  runStandaloneSemanticPerformanceHardGate,
  verifyStandaloneSemanticPerformanceHardGate,
} from '../src/toolchain/standalone-semantic-performance-hard-gate.js'

const root = new URL('../', import.meta.url)
const readJson = async (path) => JSON.parse(await readFile(
  new URL(path, root),
  'utf8',
))

const releaseLock = await readJson('release/agent-project-release-lock.json')
const inputs = {
  crossEvidence: await readJson(
    'release/standalone-cross-platform-evidence.json',
  ),
  crossMatrix: await readJson(
    'release/standalone-cross-platform-matrix.json',
  ),
  llvmEvidence: await readJson('release/llvm-aot-external-evidence.json'),
  loadGraph: async (entry) => {
    const source = await readFile(new URL(entry.graph, root), 'utf8')
    const checked = checkSource(source, { file: entry.graph })
    if (!checked.ok) fail(checked.diagnostics[0].code)
    return { ...checked.program, graph_revision: entry.graph_revision }
  },
  package: await readJson('release/portable-runtime-package.json'),
  policy: await readJson(
    'test/fixtures/standalone-semantic-performance-hard-gate.json',
  ),
  portableBundle: await readJson(
    'test/fixtures/portable-conformance.json',
  ),
  portableGate: await readJson(
    'release/portable-execution-hard-gate-report.json',
  ),
  release_lock_digest: agentProjectReleaseLockDigest(releaseLock),
  standaloneReports: {
    fault: await readJson('release/standalone-fault-host-report.json'),
    minimal_std: await readJson('release/standalone-minimal-std-report.json'),
    portable_vm: await readJson('release/standalone-portable-vm-report.json'),
    task_lifecycle: await readJson(
      'release/standalone-task-lifecycle-report.json',
    ),
  },
  toolchain_digest: releaseLock.toolchain.digest,
}

const generated = await runStandaloneSemanticPerformanceHardGate(inputs)
if (!generated.ok) fail(generated.diagnostics[0].code)
const verified = await verifyStandaloneSemanticPerformanceHardGate(
  generated.value,
  inputs,
)
if (!verified.ok) fail(verified.diagnostics[0].code)

await writeFile(
  new URL('release/standalone-semantic-performance-hard-gate-report.json', root),
  `${JSON.stringify(generated.value, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${generated.value.report_digest}\n`)

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
