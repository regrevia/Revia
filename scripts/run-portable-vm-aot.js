#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import {
  agentProjectReleaseLockDigest,
} from '../src/runtime/backend-contract.js'
import {
  digestTrackedFiles,
} from '../src/runtime/release-evidence.js'
import {
  RELEASE_TOOLCHAIN_PATHS,
} from '../src/runtime/release-toolchain-inventory.js'
import { checkSource } from '../src/toolchain/demo-toolchain.js'
import {
  runPortableVmAotConformance,
} from '../src/toolchain/portable-vm-aot.js'

const root = new URL('../', import.meta.url)
const readJson = async (path) => JSON.parse(await readFile(
  new URL(path, root),
  'utf8',
))

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('portable-vm-aot-environment-unsupported')
  }
  const [bundle, lock, policy] = await Promise.all([
    readJson('test/fixtures/portable-conformance.json'),
    readJson('release/agent-project-release-lock.json'),
    readJson('test/fixtures/portable-runtime-package.json'),
  ])
  const toolchainDigest = await digestTrackedFiles(
    await Promise.all(RELEASE_TOOLCHAIN_PATHS.map(async (path) => ({
      path,
      bytes: await readFile(new URL(path, root)),
    }))),
  )
  if (toolchainDigest !== lock.toolchain.digest) {
    fail('portable-vm-aot-toolchain-digest-mismatch')
  }
  const result = await runPortableVmAotConformance({
    bundle,
    compiler_path: '/usr/bin/clang',
    loadGraph: async (entry) => {
      const source = await readFile(new URL(entry.graph, root), 'utf8')
      const checked = checkSource(source, { file: entry.graph })
      if (!checked.ok) fail(checked.diagnostics[0].code)
      return { ...checked.program, graph_revision: entry.graph_revision }
    },
    release_lock_digest: agentProjectReleaseLockDigest(lock),
    target_triple: policy.target.target_triple,
    toolchain_digest: toolchainDigest,
  })
  if (!result.ok) fail(result.diagnostics[0].code)
  await writeFile(
    new URL('release/portable-vm-aot-report.json', root),
    `${JSON.stringify(result.value, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${result.value.report_digest}\n`)
} catch (error) {
  process.stderr.write(`${error?.code ?? 'portable-vm-aot-runner-failed'}\n`)
  process.exitCode = 1
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
