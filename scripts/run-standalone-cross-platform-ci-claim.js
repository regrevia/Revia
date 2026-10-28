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
  createMinimalStdNativeBundle,
} from '../src/toolchain/minimal-std-native.js'
import {
  STANDALONE_CROSS_PLATFORM_TARGETS,
  createStandaloneCrossPlatformCiClaim,
  createStandaloneCrossPlatformRequest,
  runStandaloneCrossPlatformRequest,
} from '../src/toolchain/standalone-cross-platform-runner.js'

const root = new URL('../', import.meta.url)

try {
  const options = parseOptions(process.argv.slice(2))
  const target = STANDALONE_CROSS_PLATFORM_TARGETS.find(
    ({ id }) => id === options.target,
  )
  if (target === undefined) fail('standalone-cross-platform-cli-target-invalid')
  const [
    abi,
    faultCorpus,
    faultReference,
    lifecycleCorpus,
    lifecycleReference,
    lock,
    minimalStdCorpus,
    packageArchive,
    portableBundle,
    reports,
    workflowSource,
    faultSource,
  ] = await Promise.all([
    readJson('release/minimal-std-abi-report.json'),
    readJson('test/fixtures/portable-fault-protocol.json'),
    readJson('release/portable-fault-protocol-report.json'),
    readJson('test/fixtures/task-runtime-lifecycle.json'),
    readJson('release/task-runtime-lifecycle-report.json'),
    readJson('release/agent-project-release-lock.json'),
    readJson('test/fixtures/minimal-std-native.json'),
    readJson('release/portable-runtime-package.json'),
    readJson('test/fixtures/portable-conformance.json'),
    readReports(),
    readFile(
      new URL('.github/workflows/standalone-cross-platform.yml', root),
      'utf8',
    ),
    readFile(new URL('test/golden/canonical-hello.re', root), 'utf8'),
  ])
  const toolchainDigest = await digestTrackedFiles(
    await Promise.all(RELEASE_TOOLCHAIN_PATHS.map(async (path) => ({
      bytes: await readFile(new URL(path, root)),
      path,
    }))),
  )
  if (toolchainDigest !== lock.toolchain.digest) {
    fail('standalone-cross-platform-toolchain-digest-mismatch')
  }
  const minimalStdBundle = createMinimalStdNativeBundle({
    abi,
    corpus: minimalStdCorpus,
  })
  if (!minimalStdBundle.ok) fail(minimalStdBundle.diagnostics[0].code)
  const checked = checkSource(faultSource, {
    file: 'test/golden/canonical-hello.re',
  })
  if (!checked.ok) fail(checked.diagnostics[0].code)
  const request = createStandaloneCrossPlatformRequest({
    challenge: options.challenge,
    package: packageArchive,
    release_lock_digest: agentProjectReleaseLockDigest(lock),
    reports,
    target,
    toolchain_digest: toolchainDigest,
  })
  if (!request.ok) fail(request.diagnostics[0].code)
  const receipt = await runStandaloneCrossPlatformRequest({
    compiler_path: options.compiler,
    fault: {
      corpus: faultCorpus,
      graph: {
        ...checked.program,
        graph_revision: faultReference.graph_revision,
      },
      protocol_report: faultReference,
    },
    lifecycle: {
      corpus: lifecycleCorpus,
      reference: lifecycleReference,
    },
    minimal_std: {
      abi,
      bundle: minimalStdBundle.value,
      corpus: minimalStdCorpus,
    },
    package: packageArchive,
    portable_vm: {
      bundle: portableBundle,
      loadGraph,
    },
    reports,
    request: request.value,
  })
  if (!receipt.ok) fail(receipt.diagnostics[0].code)
  const claim = createStandaloneCrossPlatformCiClaim({
    github: githubProvenance(),
    receipt: receipt.value,
    request: request.value,
    workflow_source: workflowSource,
  })
  if (!claim.ok) fail(claim.diagnostics[0].code)
  await writeFile(
    options.output,
    `${JSON.stringify(claim.value, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${claim.value.claim_digest}\n`)
} catch (error) {
  process.stderr.write(
    `${error?.code ?? 'standalone-cross-platform-ci-claim-failed'}\n`,
  )
  process.exitCode = 1
}

function parseOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      fail('standalone-cross-platform-cli-arguments-invalid')
    }
    options[key.slice(2)] = value
  }
  if (!/^[0-9a-f]{64}$/u.test(options.challenge ?? '')
    || typeof options.compiler !== 'string'
    || options.compiler.length === 0
    || typeof options.output !== 'string'
    || options.output.length === 0
    || typeof options.target !== 'string') {
    fail('standalone-cross-platform-cli-arguments-invalid')
  }
  return options
}

async function readReports() {
  const [
    faultHost,
    minimalStd,
    portableVm,
    taskLifecycle,
  ] = await Promise.all([
    readJson('release/standalone-fault-host-report.json'),
    readJson('release/standalone-minimal-std-report.json'),
    readJson('release/standalone-portable-vm-report.json'),
    readJson('release/standalone-task-lifecycle-report.json'),
  ])
  return {
    fault_host: faultHost,
    minimal_std: minimalStd,
    portable_vm: portableVm,
    task_lifecycle: taskLifecycle,
  }
}

async function loadGraph(entry) {
  const source = await readFile(new URL(entry.graph, root), 'utf8')
  const checked = checkSource(source, { file: entry.graph })
  if (!checked.ok) fail(checked.diagnostics[0].code)
  return { ...checked.program, graph_revision: entry.graph_revision }
}

function githubProvenance() {
  const required = [
    'GITHUB_EVENT_NAME',
    'GITHUB_JOB',
    'GITHUB_REF',
    'GITHUB_REPOSITORY',
    'GITHUB_SHA',
    'GITHUB_WORKFLOW_REF',
    'GITHUB_WORKFLOW_SHA',
    'RUNNER_ARCH',
    'RUNNER_ENVIRONMENT',
    'RUNNER_OS',
  ]
  if (required.some((name) => !process.env[name])) {
    fail('standalone-cross-platform-ci-environment-invalid')
  }
  return {
    event_name: process.env.GITHUB_EVENT_NAME,
    job: process.env.GITHUB_JOB,
    ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY,
    runner_arch: process.env.RUNNER_ARCH,
    runner_environment: process.env.RUNNER_ENVIRONMENT,
    runner_os: process.env.RUNNER_OS,
    sha: process.env.GITHUB_SHA,
    workflow_ref: process.env.GITHUB_WORKFLOW_REF,
    workflow_sha: process.env.GITHUB_WORKFLOW_SHA,
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'))
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
