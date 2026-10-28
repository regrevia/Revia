import { readFile, writeFile } from 'node:fs/promises'

import { runBackendBenchmark } from '../src/runtime/backend-benchmark.js'
import { createProductionBackend } from '../src/runtime/production-backend.js'
import { digestTrackedFiles } from '../src/runtime/release-evidence.js'
import { RELEASE_TOOLCHAIN_PATHS } from '../src/runtime/release-toolchain-inventory.js'
import { loadProjectDirectory } from '../src/toolchain/project-loader.js'

const repositoryRoot = new URL('../', import.meta.url)
const output = new URL('../release/agent-project-benchmark-report.json', import.meta.url)
const lock = JSON.parse(await readFile(
  new URL('../release/agent-project-release-lock.json', import.meta.url),
  'utf8',
))
const backendPaths = [
  'src/runtime/backend-benchmark.js',
  'src/runtime/backend-contract.js',
  'src/runtime/benchmark-matrix.js',
  'src/runtime/custody-runner-evidence.js',
  'src/runtime/external-evidence-adapters.js',
  'src/runtime/external-evidence-ingestion.js',
  'src/runtime/key-custody-audit.js',
  'src/runtime/multimachine-evidence.js',
  'src/runtime/native-backend-candidate.js',
  'src/runtime/production-backend.js',
  'src/runtime/reference-backend.js',
  'src/runtime/release-eligibility.js',
  'src/runtime/release-evidence.js',
  'src/runtime/release-installer.js',
  'src/runtime/release-key-lifecycle.js',
  'src/runtime/release-signature.js',
  'src/runtime/supported-native-backend.js',
]
const backendDigest = digestTrackedFiles(await trackedEntries(backendPaths))
const toolchainDigest = digestTrackedFiles(await trackedEntries(RELEASE_TOOLCHAIN_PATHS))
if (backendDigest !== lock.backend.digest || toolchainDigest !== lock.toolchain.digest) {
  throw new TypeError('release evidence digest mismatch')
}
const loaded = await loadProjectDirectory(
  new URL('../test/fixtures/agent-expense-review/', import.meta.url).pathname,
)
if (!loaded.ok) throw new TypeError(loaded.diagnostics[0].code)
const backend = createProductionBackend({
  artifact_digest: backendDigest,
  profile_digest: lock.profile.digest,
  toolchain_digest: toolchainDigest,
})
const report = await runBackendBenchmark({
  backend,
  iterations: 30,
  project: enrichProject(loaded.value),
  releaseLock: lock,
})
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${report.report_digest}\n`)

async function trackedEntries(paths) {
  return Promise.all(paths.map(async (path) => ({
    bytes: await readFile(new URL(path, repositoryRoot)),
    path,
  })))
}

function enrichProject(input) {
  const project = structuredClone(input)
  project.resources = [{ alias: 'expense_db', key: 'expense_db', uid: uid('f') }]
  project.modules = project.modules.map((module, index) => ({
    ...module,
    uid: uid(String.fromCharCode(97 + index)),
    edges: [{
      from: `${module.name}.input`,
      to: `${module.name}.output`,
      uid: uid(String.fromCharCode(104 + index)),
    }],
    states: [{ name: 'ready', uid: uid(String.fromCharCode(111 + index)) }],
    tasks: [{
      name: `${module.name}.task`,
      task_id: `sha256:${String.fromCharCode(97 + index).repeat(64)}`,
    }],
    surface: {
      ...module.surface,
      capabilities: [{
        instance: `${module.name}.db`,
        member: 'write',
        reference: 'db.write@0.1.0',
        uid: uid(String.fromCharCode(117 + index)),
      }],
      errors: [{
        name: `${module.name}.error`,
        uid: uid(String.fromCharCode(50 + index)),
      }],
    },
  }))
  return project
}

function uid(letter) {
  return `${letter.repeat(25)}e`
}
