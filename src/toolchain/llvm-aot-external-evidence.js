import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  arch,
  platform,
  release,
  tmpdir,
} from 'node:os'
import { isAbsolute, join } from 'node:path'

import { compilePortableBytecode } from './portable-bytecode.js'
import {
  BACKEND_FEASIBILITY_PROBES,
} from './backend-feasibility.js'
import {
  runPortableExecutorBenchmark,
} from './portable-executor-equivalence.js'

export const LLVM_AOT_EXTERNAL_EVIDENCE_SCHEMA =
  're.llvm-aot-external-evidence@0.1.0'
export const LLVM_AOT_EXTERNAL_PROFILE =
  're.llvm-aot-external-runner@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u
const REPORT_FIELDS = [
  'bundle_digest',
  'candidate',
  'evidence_digest',
  'profile',
  'provenance',
  'release_lock_digest',
  'schema',
  'stable_digest',
  'status',
  'toolchain_digest',
  'workloads',
]
const PROVENANCE_FIELDS = [
  'architecture',
  'compiler_digest',
  'compiler_path',
  'compiler_version_digest',
  'environment_id',
  'host_identity_digest',
  'measurement_source',
  'operating_system',
  'runner_id',
  'synthetic',
  'target_triple',
]
const WORKLOAD_FIELDS = [
  'artifact_digest',
  'build',
  'executable_digest',
  'execution',
  'id',
  'request_digest',
  'run',
  'source_digest',
  'stdout_digest',
  'workload_digest',
]
const METRIC_FIELDS = ['samples_ns']
const EXECUTION_FIELDS = [
  'artifact_digest',
  'graph_revision',
  'invocations',
  'outcome',
]

export async function runLlvmAotExternalEvidence({
  bundle,
  compiler_path,
  loadGraph,
  release_lock_digest,
  samples = 3,
  target_triple,
  toolchain_digest,
} = {}) {
  let root = null
  let activeWorkload = null
  try {
    validateRunInput({
      compiler_path,
      loadGraph,
      release_lock_digest,
      samples,
      target_triple,
      toolchain_digest,
    })
    const compilerBytes = await readFile(compiler_path)
    const compilerMetadata = await stat(compiler_path)
    if (!compilerMetadata.isFile()) fail('llvm-aot-compiler-invalid')
    const compilerVersion = spawnSync(
      compiler_path,
      ['--version'],
      { encoding: 'utf8', shell: false },
    )
    if (compilerVersion.error || compilerVersion.status !== 0
      || compilerVersion.stdout.length === 0) {
      fail('llvm-aot-compiler-version-failed')
    }

    const reference = await runPortableExecutorBenchmark(bundle, { loadGraph })
    if (!reference.ok) return reference
    const referenceWorkloads = reference.value.candidates[0].workloads
    const compilerDigest = digestBytes(compilerBytes)
    const compilerVersionDigest = digestBytes(
      Buffer.from(compilerVersion.stdout, 'utf8'),
    )
    const provenance = createProvenance({
      compiler_digest: compilerDigest,
      compiler_path,
      compiler_version_digest: compilerVersionDigest,
      target_triple,
    })
    root = await mkdtemp(join(tmpdir(), 're-llvm-aot-evidence-'))
    const workloads = []

    for (let index = 0; index < bundle.cases.length; index += 1) {
      const entry = bundle.cases[index]
      activeWorkload = entry.id
      const graph = await loadGraph(entry)
      if (!plainObject(graph) || graph.graph_revision !== entry.graph_revision) {
        fail('llvm-aot-graph-authority-mismatch')
      }
      const compiled = compilePortableBytecode(graph)
      if (!compiled.ok) return compiled
      const artifact = compiled.value
      const source = lowerPortableArtifactToC(artifact, entry.invocations)
      const sourceDigest = digestBytes(Buffer.from(source, 'utf8'))
      const sourcePath = join(root, `${index}.c`)
      const executablePath = join(root, `${index}.bin`)
      await writeFile(sourcePath, source, 'utf8')

      const buildSamples = []
      let executableDigest = null
      for (let sample = 0; sample < samples; sample += 1) {
        const started = process.hrtime.bigint()
        const built = spawnSync(
          compiler_path,
          [
            '-O2',
            '-std=c11',
            '-target',
            target_triple,
            sourcePath,
            '-o',
            executablePath,
          ],
          { cwd: root, encoding: 'utf8', shell: false },
        )
        buildSamples.push(elapsed(started))
        if (built.error || built.status !== 0) {
          fail('llvm-aot-compile-failed')
        }
        const metadata = await stat(executablePath)
        if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
          fail('llvm-aot-executable-missing')
        }
        const currentDigest = digestBytes(await readFile(executablePath))
        if (executableDigest !== null && executableDigest !== currentDigest) {
          fail('llvm-aot-build-nondeterministic')
        }
        executableDigest = currentDigest
      }

      const runSamples = []
      let stdout = null
      for (let sample = 0; sample < samples; sample += 1) {
        const started = process.hrtime.bigint()
        const executed = spawnSync(
          executablePath,
          [],
          { cwd: root, encoding: 'utf8', shell: false },
        )
        runSamples.push(elapsed(started))
        if (executed.error || executed.status !== 0 || executed.stderr !== '') {
          fail('llvm-aot-execution-failed')
        }
        if (stdout !== null && stdout !== executed.stdout) {
          fail('llvm-aot-execution-nondeterministic')
        }
        stdout = executed.stdout
      }

      let execution
      try {
        execution = JSON.parse(stdout)
      } catch {
        fail('llvm-aot-execution-output-invalid')
      }
      const expected = expectedExecution(referenceWorkloads[index])
      if (!canonicalEqual(execution, expected)) {
        fail('llvm-aot-semantic-oracle-mismatch')
      }
      const workload = {
        artifact_digest: artifact.artifact_digest,
        build: { samples_ns: buildSamples },
        executable_digest: executableDigest,
        execution,
        id: entry.id,
        request_digest: referenceWorkloads[index].request.request_digest,
        run: { samples_ns: runSamples },
        source_digest: sourceDigest,
        stdout_digest: digestBytes(Buffer.from(stdout, 'utf8')),
      }
      workload.workload_digest = workloadDigest(workload)
      workloads.push(workload)
    }

    const report = {
      bundle_digest: digestValue(bundle),
      candidate: 'aot-llvm',
      profile: LLVM_AOT_EXTERNAL_PROFILE,
      provenance,
      release_lock_digest,
      schema: LLVM_AOT_EXTERNAL_EVIDENCE_SCHEMA,
      status: 'measured',
      toolchain_digest,
      workloads,
    }
    report.stable_digest = llvmAotExternalStableDigest(report)
    report.evidence_digest = llvmAotExternalEvidenceDigest(report)
    const verified = await verifyLlvmAotExternalEvidence(report, {
      bundle,
      loadGraph,
      release_lock_digest,
      toolchain_digest,
    })
    return verified.ok ? { ok: true, value: report } : verified
  } catch (error) {
    return rejected(
      error?.code ?? 'llvm-aot-external-runner-failed',
      {
        reason: error?.message ?? 'unknown external runner failure',
        ...(activeWorkload === null ? {} : { workload: activeWorkload }),
      },
    )
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function verifyLlvmAotExternalEvidence(report, {
  bundle,
  loadGraph,
  release_lock_digest,
  toolchain_digest,
} = {}) {
  try {
    if (!plainObject(report)
      || !exactShape(report, REPORT_FIELDS)
      || report.schema !== LLVM_AOT_EXTERNAL_EVIDENCE_SCHEMA
      || report.profile !== LLVM_AOT_EXTERNAL_PROFILE
      || report.candidate !== 'aot-llvm'
      || report.status !== 'measured'
      || !DIGEST.test(report.bundle_digest)
      || !DIGEST.test(report.release_lock_digest)
      || !DIGEST.test(report.toolchain_digest)
      || !DIGEST.test(report.stable_digest)
      || !DIGEST.test(report.evidence_digest)) {
      fail('llvm-aot-report-invalid')
    }
    if (report.release_lock_digest !== release_lock_digest
      || report.toolchain_digest !== toolchain_digest
      || report.bundle_digest !== digestValue(bundle)) {
      fail('llvm-aot-report-authority-mismatch')
    }
    validateProvenance(report.provenance)
    await validateCurrentCompiler(report.provenance)
    if (!Array.isArray(report.workloads)
      || report.workloads.length !== bundle.cases.length
      || !canonicalEqual(
        report.workloads.map(({ id }) => id),
        bundle.cases.map(({ id }) => id),
      )) {
      fail('llvm-aot-workload-set-mismatch')
    }

    const reference = await runPortableExecutorBenchmark(bundle, { loadGraph })
    if (!reference.ok) return reference
    const referenceWorkloads = reference.value.candidates[0].workloads
    for (let index = 0; index < bundle.cases.length; index += 1) {
      const workload = report.workloads[index]
      if (!plainObject(workload)
        || !exactShape(workload, WORKLOAD_FIELDS)
        || !WORKLOAD_FIELDS.filter((field) => field.endsWith('_digest'))
          .every((field) => DIGEST.test(workload[field]))) {
        fail('llvm-aot-workload-invalid')
      }
      validateMetric(workload.build)
      validateMetric(workload.run)
      const entry = bundle.cases[index]
      const graph = await loadGraph(entry)
      if (!plainObject(graph) || graph.graph_revision !== entry.graph_revision) {
        fail('llvm-aot-graph-authority-mismatch')
      }
      const compiled = compilePortableBytecode(graph)
      if (!compiled.ok) return compiled
      const referenceWorkload = referenceWorkloads[index]
      if (workload.artifact_digest !== compiled.value.artifact_digest
        || workload.request_digest !== referenceWorkload.request.request_digest) {
        fail('llvm-aot-workload-authority-mismatch')
      }
      const source = lowerPortableArtifactToC(
        compiled.value,
        entry.invocations,
      )
      if (workload.source_digest !== digestBytes(Buffer.from(source, 'utf8'))) {
        fail('llvm-aot-source-authority-mismatch')
      }
      const expected = expectedExecution(referenceWorkload)
      if (!validExecution(workload.execution)
        || !canonicalEqual(workload.execution, expected)) {
        fail('llvm-aot-semantic-oracle-mismatch')
      }
      const expectedStdout = `${JSON.stringify(expected)}\n`
      if (workload.stdout_digest !== digestBytes(
        Buffer.from(expectedStdout, 'utf8'),
      )) {
        fail('llvm-aot-stdout-authority-mismatch')
      }
      if (workload.workload_digest !== workloadDigest(workload)) {
        fail('llvm-aot-workload-digest-mismatch')
      }
    }
    if (report.stable_digest !== llvmAotExternalStableDigest(report)) {
      fail('llvm-aot-stable-digest-mismatch')
    }
    if (report.evidence_digest !== llvmAotExternalEvidenceDigest(report)) {
      fail('llvm-aot-evidence-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'llvm-aot-evidence-invalid')
  }
}

export function llvmAotExternalStableDigest(report) {
  if (!plainObject(report)) throw new TypeError('invalid LLVM AOT report')
  const {
    evidence_digest: ignoredEvidence,
    stable_digest: ignoredStable,
    workloads = [],
    ...identity
  } = report
  return digestValue({
    ...identity,
    workloads: workloads.map(({ build: ignoredBuild, run: ignoredRun, ...item }) => (
      item
    )),
  })
}

export function llvmAotExternalEvidenceDigest(report) {
  if (!plainObject(report)) throw new TypeError('invalid LLVM AOT report')
  const { evidence_digest: ignored, ...content } = report
  return digestValue(content)
}

export function llvmAotFeasibilityObservations(report) {
  if (!plainObject(report)
    || report.schema !== LLVM_AOT_EXTERNAL_EVIDENCE_SCHEMA
    || report.candidate !== 'aot-llvm'
    || report.status !== 'measured'
    || !DIGEST.test(report.evidence_digest)
    || !DIGEST.test(report.toolchain_digest)) {
    throw new TypeError('invalid LLVM AOT feasibility evidence')
  }
  validateProvenance(report.provenance)
  const provenance = {
    environment_id: report.provenance.environment_id,
    host_identity_digest: report.provenance.host_identity_digest,
    measurement_source: 'runner',
    runner_id: report.provenance.runner_id,
    synthetic: false,
    toolchain_digest: report.toolchain_digest,
  }
  return BACKEND_FEASIBILITY_PROBES.map(({ id }) => ({
    candidate: 'aot-llvm',
    evidence_digest: report.evidence_digest,
    probe: id,
    provenance: structuredClone(provenance),
    status: 'reported',
  }))
}

export function lowerPortableArtifactToC(artifact, invocations) {
  if (!plainObject(artifact)
    || !Array.isArray(artifact.instructions)
    || artifact.instructions.length !== 4
    || !Array.isArray(invocations)
    || invocations.length !== 1) {
    fail('llvm-aot-lowering-input-invalid')
  }
  const [invoke, branch, okExit, errExit] = artifact.instructions
  if (invoke.op !== 'invoke-capability'
    || branch.op !== 'branch-result'
    || okExit.op !== 'process-exit'
    || errExit.op !== 'process-exit') {
    fail('llvm-aot-opcode-unsupported')
  }
  const transcript = invocations[0]
  const responseKind = transcript?.response?.kind === 'value'
    ? transcript.response.value?.kind
    : null
  if (!['err', 'ok'].includes(responseKind)) {
    fail('llvm-aot-transcript-response-unsupported')
  }
  const artifactArguments = Object.fromEntries(
    invoke.arguments.map(({ literal, name }) => [
      name,
      encodedLiteral(artifact.literals[literal]),
    ]),
  )
  const transcriptArguments = normalizeTranscriptArguments(
    transcript.instance,
    transcript.member,
    transcript.arguments,
  )
  const okCode = exitCode(artifact.literals[okExit.code_literal])
  const errCode = exitCode(artifact.literals[errExit.code_literal])
  const outputPrefix = [
    '{"artifact_digest":',
    JSON.stringify(artifact.artifact_digest),
    ',"graph_revision":',
    JSON.stringify(artifact.graph_revision),
    ',"invocations":[{"instance":',
    JSON.stringify(invoke.instance),
    ',"invocation_id":',
    JSON.stringify(invoke.invocation_id),
    ',"member":',
    JSON.stringify(invoke.member),
    ',"outcome":"',
  ].join('')
  const outputSuffix = [
    '"}],"outcome":{"code":%d,"type":"process.status"}}\n',
  ].join('')

  return [
    '#include <stdio.h>',
    '#include <string.h>',
    '',
    'int main(void) {',
    `  const char *artifact_instance = ${cString(invoke.instance)};`,
    `  const char *artifact_member = ${cString(invoke.member)};`,
    `  const char *artifact_invocation = ${cString(invoke.invocation_id)};`,
    `  const char *artifact_arguments = ${cString(canonicalJson(artifactArguments))};`,
    `  const char *transcript_instance = ${cString(transcript.instance)};`,
    `  const char *transcript_member = ${cString(transcript.member)};`,
    `  const char *transcript_invocation = ${cString(transcript.invocation_id)};`,
    `  const char *transcript_arguments = ${cString(canonicalJson(transcriptArguments))};`,
    `  const int transcript_result = ${responseKind === 'ok' ? 1 : 2};`,
    '  if (strcmp(artifact_instance, transcript_instance) != 0',
    '      || strcmp(artifact_member, transcript_member) != 0',
    '      || strcmp(artifact_invocation, transcript_invocation) != 0',
    '      || strcmp(artifact_arguments, transcript_arguments) != 0) return 70;',
    '  int pc = 0;',
    '  int exit_code = -1;',
    '  const char *invocation_outcome = NULL;',
    '  for (;;) {',
    '    switch (pc) {',
    `      case 0: invocation_outcome = transcript_result == 1 ? "ok" : "err"; pc = 1; break;`,
    `      case 1: pc = transcript_result == 1 ? ${branch.ok} : ${branch.err}; break;`,
    `      case ${branch.ok}: exit_code = ${okCode}; goto complete;`,
    `      case ${branch.err}: exit_code = ${errCode}; goto complete;`,
    '      default: return 71;',
    '    }',
    '  }',
    'complete:',
    `  printf(${cString(`${outputPrefix}%s${outputSuffix}`)}, invocation_outcome, exit_code);`,
    '  return 0;',
    '}',
    '',
  ].join('\n')
}

function expectedExecution(referenceWorkload) {
  return {
    artifact_digest: referenceWorkload.request.artifact_digest,
    graph_revision: referenceWorkload.request.graph_revision,
    invocations: structuredClone(
      referenceWorkload.result.receipt.invocations,
    ),
    outcome: structuredClone(referenceWorkload.result.outcome),
  }
}

function createProvenance({
  compiler_digest,
  compiler_path,
  compiler_version_digest,
  target_triple,
}) {
  const operatingSystem = platform()
  const architecture = arch()
  return {
    architecture,
    compiler_digest,
    compiler_path,
    compiler_version_digest,
    environment_id: `${operatingSystem}-${architecture}-llvm-aot`,
    host_identity_digest: digestValue({
      architecture,
      compiler_digest,
      operating_system: operatingSystem,
      release: release(),
      target_triple,
    }),
    measurement_source: 'runner',
    operating_system: operatingSystem,
    runner_id: LLVM_AOT_EXTERNAL_PROFILE,
    synthetic: false,
    target_triple,
  }
}

async function validateCurrentCompiler(provenance) {
  if (platform() !== provenance.operating_system
    || arch() !== provenance.architecture) return
  let compilerBytes
  let version
  try {
    compilerBytes = await readFile(provenance.compiler_path)
    version = spawnSync(
      provenance.compiler_path,
      ['--version'],
      { encoding: 'utf8', shell: false },
    )
  } catch {
    fail('llvm-aot-compiler-identity-mismatch')
  }
  if (version.error || version.status !== 0
    || digestBytes(compilerBytes) !== provenance.compiler_digest
    || digestBytes(Buffer.from(version.stdout, 'utf8'))
      !== provenance.compiler_version_digest) {
    fail('llvm-aot-compiler-identity-mismatch')
  }
}

function validateProvenance(value) {
  if (!plainObject(value)
    || !exactShape(value, PROVENANCE_FIELDS)
    || typeof value.architecture !== 'string'
    || value.architecture.length === 0
    || !DIGEST.test(value.compiler_digest)
    || !isAbsolute(value.compiler_path)
    || !DIGEST.test(value.compiler_version_digest)
    || typeof value.environment_id !== 'string'
    || value.environment_id.length === 0
    || !DIGEST.test(value.host_identity_digest)
    || value.measurement_source !== 'runner'
    || typeof value.operating_system !== 'string'
    || value.operating_system.length === 0
    || value.runner_id !== LLVM_AOT_EXTERNAL_PROFILE
    || value.synthetic !== false
    || typeof value.target_triple !== 'string'
    || value.target_triple.length === 0) {
    fail('llvm-aot-provenance-invalid')
  }
}

function validateRunInput({
  compiler_path,
  loadGraph,
  release_lock_digest,
  samples,
  target_triple,
  toolchain_digest,
}) {
  if (!isAbsolute(compiler_path)
    || typeof loadGraph !== 'function'
    || !DIGEST.test(release_lock_digest)
    || !Number.isSafeInteger(samples)
    || samples < 1
    || samples > 20
    || typeof target_triple !== 'string'
    || target_triple.length === 0
    || !DIGEST.test(toolchain_digest)) {
    fail('llvm-aot-runner-input-invalid')
  }
}

function validateMetric(value) {
  if (!plainObject(value)
    || !exactShape(value, METRIC_FIELDS)
    || !Array.isArray(value.samples_ns)
    || value.samples_ns.length < 1
    || value.samples_ns.length > 20
    || !value.samples_ns.every((sample) => POSITIVE_INTEGER.test(sample))) {
    fail('llvm-aot-metric-invalid')
  }
}

function validExecution(value) {
  return plainObject(value)
    && exactShape(value, EXECUTION_FIELDS)
    && DIGEST.test(value.artifact_digest)
    && DIGEST.test(value.graph_revision)
    && Array.isArray(value.invocations)
    && plainObject(value.outcome)
    && Number.isSafeInteger(value.outcome.code)
    && value.outcome.code >= 0
    && value.outcome.code <= 255
    && value.outcome.type === 'process.status'
}

function normalizeTranscriptArguments(instance, member, arguments_) {
  if (!plainObject(arguments_)) fail('llvm-aot-transcript-arguments-invalid')
  return arguments_
}

function encodedLiteral(literal) {
  if (!plainObject(literal)) fail('llvm-aot-literal-invalid')
  return literal.type === 'bytes'
    ? { $bytes: literal.value }
    : literal.value
}

function exitCode(literal) {
  if (!plainObject(literal)
    || literal.type !== 'int'
    || !/^(?:0|-?[1-9][0-9]*)$/u.test(literal.value)) {
    fail('llvm-aot-exit-literal-invalid')
  }
  const value = Number(BigInt(literal.value))
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    fail('llvm-aot-exit-literal-invalid')
  }
  return value
}

function workloadDigest(workload) {
  const {
    build: ignoredBuild,
    run: ignoredRun,
    workload_digest: ignored,
    ...content
  } = workload
  return digestValue(content)
}

function elapsed(started) {
  const duration = process.hrtime.bigint() - started
  return (duration > 0n ? duration : 1n).toString()
}

function cString(value) {
  const bytes = Buffer.from(value, 'utf8')
  return `"${[...bytes].map(
    (byte) => `\\x${byte.toString(16).padStart(2, '0')}`,
  ).join('')}"`
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function digestValue(value) {
  return digestBytes(Buffer.from(canonicalJson(value), 'utf8'))
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function exactShape(value, fields) {
  return Object.keys(value).sort().join(',') === [...fields].sort().join(',')
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}

function rejected(code, detail = {}) {
  return { diagnostics: [{ code, ...detail }], ok: false }
}
