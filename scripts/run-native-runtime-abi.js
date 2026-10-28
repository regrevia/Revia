#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import {
  runNativeRuntimeAbiConformance,
} from '../src/toolchain/native-runtime-abi.js'

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('native-runtime-abi-environment-unsupported')
  }
  const [policy, packageArchive, runtimeAbi, corpus] = await Promise.all([
    readJson('../test/fixtures/portable-runtime-package.json'),
    readJson('../release/portable-runtime-package.json'),
    readJson('../release/portable-runtime-abi-report.json'),
    readJson('../test/fixtures/task-runtime-lifecycle.json'),
  ])
  const reference = runtimeAbi.domains.find(
    ({ id }) => id === 'task-lifecycle',
  )?.report
  if (reference === undefined) fail('native-runtime-abi-reference-missing')
  const result = await runNativeRuntimeAbiConformance({
    compiler_path: '/usr/bin/clang',
    corpus,
    package_digest: packageArchive.package_digest,
    reference,
    target_triple: policy.target.target_triple,
  })
  if (!result.ok) fail(result.diagnostics[0].code)
  await writeFile(
    new URL('../release/native-runtime-abi-report.json', import.meta.url),
    `${JSON.stringify(result.value, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${JSON.stringify({
    package_digest: packageArchive.package_digest,
    report_digest: result.value.report_digest,
    workloads: result.value.workloads.length,
  })}\n`)
} catch (error) {
  process.stderr.write(
    `${error?.code ?? 'native-runtime-abi-runner-failed'}\n`,
  )
  process.exitCode = 1
}

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
