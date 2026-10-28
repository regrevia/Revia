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
import {
  createPortableRuntimePackage,
  runPortableRuntimePackageConformance,
} from '../src/toolchain/portable-runtime-package.js'
import {
  runNativeRuntimeAbiConformance,
} from '../src/toolchain/native-runtime-abi.js'
import {
  createMinimalStdNativeBundle,
  runMinimalStdNativeConformance,
} from '../src/toolchain/minimal-std-native.js'
import { checkSource } from '../src/toolchain/demo-toolchain.js'

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('portable-runtime-package-environment-unsupported')
  }
  const [bundle, policy, lock, llvmEvidence, minimalStdAbi, runtimeAbi,
    portableVm, portableVmStd, taskCorpus, minimalStdNative] = await Promise.all([
    readJson('../test/fixtures/portable-conformance.json'),
    readJson('../test/fixtures/portable-runtime-package.json'),
    readJson('../release/agent-project-release-lock.json'),
    readJson('../release/llvm-aot-external-evidence.json'),
    readJson('../release/minimal-std-abi-report.json'),
    readJson('../release/portable-runtime-abi-report.json'),
    readJson('../release/portable-vm-conformance-report.json'),
    readJson('../release/portable-vm-std-report.json'),
    readJson('../test/fixtures/task-runtime-lifecycle.json'),
    readJson('../test/fixtures/minimal-std-native.json'),
  ])
  const toolchainDigest = await digestTrackedFiles(
    await Promise.all(RELEASE_TOOLCHAIN_PATHS.map(async (path) => ({
      path,
      bytes: await readFile(new URL(`../${path}`, import.meta.url)),
    }))),
  )
  if (lock.toolchain.digest !== toolchainDigest) {
    fail('portable-runtime-package-toolchain-digest-mismatch')
  }
  const inputs = {
    bundle,
    llvm_evidence: llvmEvidence,
    loadGraph,
    minimal_std_abi: minimalStdAbi,
    minimal_std_native: minimalStdNative,
    policy,
    portable_runtime_abi: runtimeAbi,
    portable_vm: portableVm,
    portable_vm_std: portableVmStd,
    readSource: (path) => readFile(new URL(`../${path}`, import.meta.url)),
    release_lock_digest: agentProjectReleaseLockDigest(lock),
    task_corpus: taskCorpus,
    toolchain_digest: toolchainDigest,
  }
  const packageResult = await createPortableRuntimePackage(inputs)
  if (!packageResult.ok) fail(packageResult.diagnostics[0].code)
  const reportResult = await runPortableRuntimePackageConformance({
    compiler_path: '/usr/bin/clang',
    package: packageResult.value,
    target_triple: policy.target.target_triple,
    ...inputs,
  })
  if (!reportResult.ok) fail(reportResult.diagnostics[0].code)
  const nativeResult = await runNativeRuntimeAbiConformance({
    compiler_path: '/usr/bin/clang',
    corpus: taskCorpus,
    package_digest: packageResult.value.package_digest,
    reference: runtimeAbi.domains.find(
      ({ id }) => id === 'task-lifecycle',
    ).report,
    target_triple: policy.target.target_triple,
  })
  if (!nativeResult.ok) fail(nativeResult.diagnostics[0].code)
  const minimalStdNativeResult = await runMinimalStdNativeConformance({
    abi: minimalStdAbi,
    bundle: createMinimalStdNativeBundle({
      abi: minimalStdAbi,
      corpus: minimalStdNative,
    }).value,
    compiler_path: '/usr/bin/clang',
    corpus: minimalStdNative,
    target_triple: policy.target.target_triple,
  })
  if (!minimalStdNativeResult.ok) {
    fail(minimalStdNativeResult.diagnostics[0].code)
  }
  await Promise.all([
    writeFile(
      new URL('../release/portable-runtime-package.json', import.meta.url),
      `${JSON.stringify(packageResult.value, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      new URL(
        '../release/portable-runtime-package-conformance-report.json',
        import.meta.url,
      ),
      `${JSON.stringify(reportResult.value, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      new URL('../release/native-runtime-abi-report.json', import.meta.url),
      `${JSON.stringify(nativeResult.value, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      new URL('../release/minimal-std-native-report.json', import.meta.url),
      `${JSON.stringify(minimalStdNativeResult.value, null, 2)}\n`,
      'utf8',
    ),
  ])
  process.stdout.write(`${JSON.stringify({
    package_digest: packageResult.value.package_digest,
    native_report_digest: nativeResult.value.report_digest,
    report_digest: reportResult.value.report_digest,
    workloads: reportResult.value.workloads.length,
  })}\n`)
} catch (error) {
  process.stderr.write(
    `${error?.code ?? 'portable-runtime-package-runner-failed'}\n`,
  )
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
