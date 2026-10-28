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
  runStandaloneFaultHostConformance,
} from '../src/toolchain/standalone-fault-host-boundary.js'

const root = new URL('../', import.meta.url)

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('standalone-fault-host-environment-unsupported')
  }
  const [corpus, protocolReport, archive, lock, policy, source] =
    await Promise.all([
      readJson('test/fixtures/portable-fault-protocol.json'),
      readJson('release/portable-fault-protocol-report.json'),
      readJson('release/portable-runtime-package.json'),
      readJson('release/agent-project-release-lock.json'),
      readJson('test/fixtures/portable-runtime-package.json'),
      readFile(
        new URL('test/golden/canonical-hello.re', root),
        'utf8',
      ),
    ])
  const checked = checkSource(source, {
    file: 'test/golden/canonical-hello.re',
  })
  if (!checked.ok) fail(checked.diagnostics[0].code)
  const toolchainDigest = await digestTrackedFiles(
    await Promise.all(RELEASE_TOOLCHAIN_PATHS.map(async (path) => ({
      bytes: await readFile(new URL(path, root)),
      path,
    }))),
  )
  if (toolchainDigest !== lock.toolchain.digest) {
    fail('standalone-fault-host-toolchain-digest-mismatch')
  }
  const result = await runStandaloneFaultHostConformance({
    compiler_path: '/usr/bin/clang',
    corpus,
    graph: {
      ...checked.program,
      graph_revision: protocolReport.graph_revision,
    },
    package_digest: archive.package_digest,
    protocol_report: protocolReport,
    release_lock_digest: agentProjectReleaseLockDigest(lock),
    target_triple: policy.target.target_triple,
    toolchain_digest: toolchainDigest,
  })
  if (!result.ok) fail(result.diagnostics[0].code)
  await writeFile(
    new URL('release/standalone-fault-host-report.json', root),
    `${JSON.stringify(result.value, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${result.value.report_digest}\n`)
} catch (error) {
  process.stderr.write(
    `${error?.code ?? 'standalone-fault-host-runner-failed'}\n`,
  )
  process.exitCode = 1
}

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'))
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
