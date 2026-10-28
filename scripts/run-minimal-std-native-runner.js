#!/usr/bin/env node

import { access, readFile, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'

import {
  createMinimalStdNativeBundle,
} from '../src/toolchain/minimal-std-native.js'
import {
  MINIMAL_STD_NATIVE_RUNNER_TARGETS,
  createMinimalStdNativeRunnerEvidence,
  createMinimalStdNativeRunnerMatrix,
  createMinimalStdNativeRunnerRequest,
  runMinimalStdNativeRunner,
} from '../src/toolchain/minimal-std-native-runner.js'

try {
  const [archive, corpus, abi] = await Promise.all([
    readJson('../release/portable-runtime-package.json'),
    readJson('../test/fixtures/minimal-std-native.json'),
    readJson('../release/minimal-std-abi-report.json'),
  ])
  const bundle = createMinimalStdNativeBundle({ abi, corpus })
  if (!bundle.ok) fail(bundle.diagnostics[0].code)
  const matrix = createMinimalStdNativeRunnerMatrix({
    bundle: bundle.value,
    package: archive,
  })
  if (!matrix.ok) fail(matrix.diagnostics[0].code)

  const target = MINIMAL_STD_NATIVE_RUNNER_TARGETS.find((entry) => (
    entry.platform === platform() && entry.architecture === arch()
  ))
  const claims = []
  if (target !== undefined && await compilerAvailable(target.compiler_path)) {
    const request = createMinimalStdNativeRunnerRequest({
      bundle: bundle.value,
      challenge: '235'.padStart(64, '0'),
      package: archive,
      target,
    })
    if (!request.ok) fail(request.diagnostics[0].code)
    const receipt = await runMinimalStdNativeRunner({
      abi,
      bundle: bundle.value,
      compiler_path: target.compiler_path,
      corpus,
      package: archive,
      request: request.value,
    })
    if (!receipt.ok) fail(receipt.diagnostics[0].code)
    claims.push({ receipt: receipt.value, request: request.value })
  }
  const evidence = await createMinimalStdNativeRunnerEvidence({
    abi,
    bundle: bundle.value,
    claims,
    corpus,
    matrix: matrix.value,
    package: archive,
  })
  if (!evidence.ok) fail(evidence.diagnostics[0].code)
  await Promise.all([
    writeJson('../release/minimal-std-native-runner-matrix.json', matrix.value),
    writeJson('../release/minimal-std-native-runner-evidence.json', evidence.value),
  ])
  process.stdout.write(`${JSON.stringify({
    evidence_digest: evidence.value.evidence_digest,
    measured_targets: evidence.value.measured_targets,
    pending_targets: evidence.value.pending_targets,
  })}\n`)
} catch (error) {
  process.stderr.write(
    `${error?.code ?? 'minimal-std-native-runner-failed'}\n`,
  )
  process.exitCode = 1
}

async function compilerAvailable(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
}

async function writeJson(path, value) {
  await writeFile(
    new URL(path, import.meta.url),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  )
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
