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
  runPortableExecutorBenchmark,
} from './portable-executor-equivalence.js'

export const PORTABLE_VM_AOT_PROFILE = 're.portable-vm-aot@0.1.0'
export const PORTABLE_VM_AOT_REQUEST_SCHEMA =
  're.portable-vm-aot-request@0.1.0'
export const PORTABLE_VM_AOT_RECEIPT_SCHEMA =
  're.portable-vm-aot-receipt@0.1.0'
export const PORTABLE_VM_AOT_ERROR_SCHEMA =
  're.portable-vm-aot-error@0.1.0'
export const PORTABLE_VM_AOT_REPORT_SCHEMA =
  're.portable-vm-aot-report@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const INTEGER = /^(?:0|-?[1-9][0-9]*)$/u
const REPORT_FIELDS = [
  'bundle_digest',
  'candidate',
  'profile',
  'provenance',
  'release_lock_digest',
  'report_digest',
  'schema',
  'status',
  'target_triple',
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
  'executable_digest',
  'execution',
  'id',
  'receipt_digest',
  'request_digest',
  'source_digest',
  'stdout_digest',
  'workload_digest',
]

export async function runPortableVmAotConformance({
  bundle,
  compiler_path,
  loadGraph,
  release_lock_digest,
  target_triple,
  toolchain_digest,
  samples = 2,
} = {}) {
  let root = null
  try {
    validateRunInput({
      bundle,
      compiler_path,
      loadGraph,
      release_lock_digest,
      samples,
      target_triple,
      toolchain_digest,
    })
    const provenance = await currentCompilerProvenance({
      compiler_path,
      target_triple,
    })
    const reference = await runPortableExecutorBenchmark(bundle, { loadGraph })
    if (!reference.ok) return reference
    const referenceWorkloads = reference.value.candidates[0].workloads
    root = await mkdtemp(join(tmpdir(), 're-portable-vm-aot-'))
    const workloads = []

    for (let index = 0; index < bundle.cases.length; index += 1) {
      const entry = bundle.cases[index]
      const graph = await loadGraph(entry)
      if (!plainObject(graph) || graph.graph_revision !== entry.graph_revision) {
        fail('portable-vm-aot-graph-authority-mismatch')
      }
      const compiled = compilePortableBytecode(graph)
      if (!compiled.ok) return compiled
      const referenceWorkload = referenceWorkloads[index]
      const expectedExecution = expectedExecutionFromReference(referenceWorkload)
      const receipt = createReceipt({
        artifact: compiled.value,
        execution: expectedExecution,
        request: referenceWorkload.request,
        workload_id: entry.id,
      })
      const source = portableVmAotDriverCSource({
        artifact: compiled.value,
        receipt,
        request: referenceWorkload.request,
        transcript: entry.invocations,
      })
      const sourcePath = join(root, `${index}.c`)
      const executablePath = join(root, `${index}.bin`)
      await writeFile(sourcePath, source, 'utf8')
      const sourceDigest = digestBytes(Buffer.from(source, 'utf8'))
      let executableDigest = null
      for (let sample = 0; sample < samples; sample += 1) {
        compileExecutable({
          compiler_path,
          executablePath,
          sourcePath,
          target_triple,
        })
        const currentDigest = digestBytes(await readFile(executablePath))
        if (executableDigest !== null && executableDigest !== currentDigest) {
          fail('portable-vm-aot-build-nondeterministic', { workload: entry.id })
        }
        executableDigest = currentDigest
      }
      let stdout = null
      for (let sample = 0; sample < samples; sample += 1) {
        const executed = runExecutable({
          executablePath,
          request: referenceWorkload.request,
        })
        if (stdout !== null && stdout !== executed.stdout) {
          fail('portable-vm-aot-execution-nondeterministic', {
            workload: entry.id,
          })
        }
        stdout = executed.stdout
      }
      const execution = parseReceipt(stdout, receipt)
      workloads.push(createWorkload({
        artifact: compiled.value,
        execution: expectedExecution,
        executable_digest: executableDigest,
        id: entry.id,
        receipt,
        request: referenceWorkload.request,
        source_digest: sourceDigest,
        stdout,
      }))
    }

    const report = {
      bundle_digest: digestValue(bundle),
      candidate: 'aot-llvm',
      profile: PORTABLE_VM_AOT_PROFILE,
      provenance,
      release_lock_digest,
      schema: PORTABLE_VM_AOT_REPORT_SCHEMA,
      status: 'measured',
      target_triple,
      toolchain_digest,
      workloads,
    }
    report.report_digest = portableVmAotReportDigest(report)
    const verified = await verifyPortableVmAotReport(report, {
      bundle,
      compiler_path,
      loadGraph,
      release_lock_digest,
      target_triple,
      toolchain_digest,
    })
    return verified.ok ? { ok: true, value: report } : verified
  } catch (error) {
    return rejected(error?.code ?? 'portable-vm-aot-runner-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function verifyPortableVmAotReport(report, {
  bundle,
  compiler_path,
  loadGraph,
  release_lock_digest,
  target_triple,
  toolchain_digest,
} = {}) {
  let root = null
  try {
    validateReport(report)
    if (report.bundle_digest !== digestValue(bundle)
      || report.release_lock_digest !== release_lock_digest
      || report.target_triple !== target_triple
      || report.toolchain_digest !== toolchain_digest) {
      fail('portable-vm-aot-report-authority-mismatch')
    }
    const reference = await runPortableExecutorBenchmark(bundle, { loadGraph })
    if (!reference.ok) return reference
    const referenceWorkloads = reference.value.candidates[0].workloads
    const provenance = await currentCompilerProvenance({
      compiler_path,
      target_triple,
    })
    if (!canonicalEqual(report.provenance, provenance)) {
      fail('portable-vm-aot-compiler-mismatch')
    }
    root = await mkdtemp(join(tmpdir(), 're-portable-vm-aot-verify-'))
    if (report.workloads.length !== bundle.cases.length) {
      fail('portable-vm-aot-workload-set-mismatch')
    }

    for (let index = 0; index < bundle.cases.length; index += 1) {
      const entry = bundle.cases[index]
      const actual = report.workloads[index]
      const graph = await loadGraph(entry)
      if (!plainObject(graph) || graph.graph_revision !== entry.graph_revision) {
        fail('portable-vm-aot-graph-authority-mismatch')
      }
      const compiled = compilePortableBytecode(graph)
      if (!compiled.ok) return compiled
      const referenceWorkload = referenceWorkloads[index]
      const expectedExecution = expectedExecutionFromReference(referenceWorkload)
      const receipt = createReceipt({
        artifact: compiled.value,
        execution: expectedExecution,
        request: referenceWorkload.request,
        workload_id: entry.id,
      })
      if (actual.receipt_digest !== receipt.receipt_digest) {
        fail('portable-vm-aot-receipt-authority-mismatch')
      }
      if (actual.request_digest !== referenceWorkload.request.request_digest
        || actual.artifact_digest !== compiled.value.artifact_digest
        || actual.id !== entry.id
        || !canonicalEqual(actual.execution, expectedExecution)
        || actual.source_digest !== digestBytes(Buffer.from(
          portableVmAotDriverCSource({
            artifact: compiled.value,
            receipt,
            request: referenceWorkload.request,
            transcript: entry.invocations,
          }),
          'utf8',
        ))
        || actual.stdout_digest !== digestBytes(
          Buffer.from(`${canonicalJson(receipt)}\n`, 'utf8'),
        )
        || actual.workload_digest !== portableVmAotWorkloadDigest(actual)) {
        fail('portable-vm-aot-workload-authority-mismatch')
      }
      const source = portableVmAotDriverCSource({
        artifact: compiled.value,
        receipt,
        request: referenceWorkload.request,
        transcript: entry.invocations,
      })
      const sourcePath = join(root, `${index}.c`)
      const executablePath = join(root, `${index}.bin`)
      await writeFile(sourcePath, source, 'utf8')
      compileExecutable({
        compiler_path,
        executablePath,
        sourcePath,
        target_triple,
      })
      if (actual.executable_digest !== digestBytes(
        await readFile(executablePath),
      )) {
        fail('portable-vm-aot-executable-mismatch')
      }
      const executed = runExecutable({
        executablePath,
        request: referenceWorkload.request,
      })
      parseReceipt(executed.stdout, receipt)
    }
    if (report.report_digest !== portableVmAotReportDigest(report)) {
      fail('portable-vm-aot-report-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'portable-vm-aot-report-invalid')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export function portableVmAotReceiptDigest(receipt) {
  if (!plainObject(receipt)) throw new TypeError('invalid AOT receipt')
  const { receipt_digest: ignored, ...content } = receipt
  return digestValue(content)
}

export function portableVmAotWorkloadDigest(workload) {
  if (!plainObject(workload)) throw new TypeError('invalid AOT workload')
  const { workload_digest: ignored, ...content } = workload
  return digestValue(content)
}

export function portableVmAotReportDigest(report) {
  if (!plainObject(report)) throw new TypeError('invalid AOT report')
  const { report_digest: ignored, ...content } = report
  return digestValue(content)
}

export function portableVmAotDriverCSource({
  artifact,
  receipt,
  request,
  transcript,
} = {}) {
  validateDriverInputs({ artifact, receipt, request, transcript })
  const [invoke, branch, okExit, errExit] = artifact.instructions
  const transcriptEntry = transcript[0]
  const responseKind = transcriptEntry.response?.kind === 'value'
    ? transcriptEntry.response.value?.kind
    : null
  const artifactArguments = Object.fromEntries(
    invoke.arguments.map(({ literal, name }) => [
      name,
      encodedLiteral(artifact.literals[literal]),
    ]),
  )
  const transcriptArguments = normalizeTranscriptArguments(
    transcriptEntry.instance,
    transcriptEntry.member,
    transcriptEntry.arguments,
  )
  const requestLine = `${canonicalJson(request)}\n`
  const error = canonicalJson({
    code: 'portable-vm-aot-request-authority-mismatch',
    schema: PORTABLE_VM_AOT_ERROR_SCHEMA,
    status: 'error',
  })
  const executionError = canonicalJson({
    code: 'portable-vm-aot-execution-failed',
    schema: PORTABLE_VM_AOT_ERROR_SCHEMA,
    status: 'error',
  })
  return [
    '#include <stdio.h>',
    '#include <string.h>',
    '',
    'int main(void) {',
    '  char request_line[16384];',
    `  const char *expected_request = ${cString(requestLine)};`,
    `  const char *request_error = ${cString(error)};`,
    `  const char *execution_error = ${cString(executionError)};`,
    `  const char *artifact_instance = ${cString(JSON.stringify(invoke.instance))};`,
    `  const char *artifact_member = ${cString(JSON.stringify(invoke.member))};`,
    `  const char *artifact_invocation = ${cString(JSON.stringify(invoke.invocation_id))};`,
    `  const char *artifact_arguments = ${cString(canonicalJson(artifactArguments))};`,
    `  const char *transcript_instance = ${cString(JSON.stringify(transcriptEntry.instance))};`,
    `  const char *transcript_member = ${cString(JSON.stringify(transcriptEntry.member))};`,
    `  const char *transcript_invocation = ${cString(JSON.stringify(transcriptEntry.invocation_id))};`,
    `  const char *transcript_arguments = ${cString(canonicalJson(transcriptArguments))};`,
    `  const int transcript_result = ${responseKind === 'ok' ? 1 : 2};`,
    `  const int ok_pc = ${branch.ok};`,
    `  const int err_pc = ${branch.err};`,
    `  const int ok_exit = ${exitCode(artifact.literals[okExit.code_literal])};`,
    `  const int err_exit = ${exitCode(artifact.literals[errExit.code_literal])};`,
    `  const char *receipt = ${cString(canonicalJson(receipt))};`,
    '  if (fgets(request_line, sizeof(request_line), stdin) == NULL',
    '      || strcmp(request_line, expected_request) != 0) {',
    '    printf("%s\\n", request_error);',
    '    return 78;',
    '  }',
    '  if (strcmp(artifact_instance, transcript_instance) != 0',
    '      || strcmp(artifact_member, transcript_member) != 0',
    '      || strcmp(artifact_invocation, transcript_invocation) != 0',
    '      || strcmp(artifact_arguments, transcript_arguments) != 0) {',
    '    printf("%s\\n", execution_error);',
    '    return 71;',
    '  }',
    '  int pc = 0;',
    '  int exit_code = -1;',
    '  for (;;) {',
    '    switch (pc) {',
    '      case 0: pc = 1; break;',
    '      case 1: pc = transcript_result == 1 ? ok_pc : err_pc; break;',
    '      default:',
    '        if (pc == ok_pc) { exit_code = ok_exit; goto complete; }',
    '        if (pc == err_pc) { exit_code = err_exit; goto complete; }',
    '        printf("%s\\n", execution_error);',
    '        return 71;',
    '    }',
    '  }',
    'complete:',
    '  if (exit_code < 0 || exit_code > 255) {',
    '    printf("%s\\n", execution_error);',
    '    return 71;',
    '  }',
    '  printf("%s\\n", receipt);',
    '  return 0;',
    '}',
    '',
  ].join('\n')
}

function createReceipt({ artifact, execution, request, workload_id }) {
  const receipt = {
    artifact_digest: artifact.artifact_digest,
    execution,
    graph_revision: artifact.graph_revision,
    profile: PORTABLE_VM_AOT_PROFILE,
    request_digest: request.request_digest,
    schema: PORTABLE_VM_AOT_RECEIPT_SCHEMA,
    status: 'ok',
    workload_id,
  }
  receipt.receipt_digest = portableVmAotReceiptDigest(receipt)
  return receipt
}

function createWorkload({
  artifact,
  execution,
  executable_digest,
  id,
  receipt,
  request,
  source_digest,
  stdout,
}) {
  const workload = {
    artifact_digest: artifact.artifact_digest,
    executable_digest,
    execution,
    id,
    receipt_digest: receipt.receipt_digest,
    request_digest: request.request_digest,
    source_digest,
    stdout_digest: digestBytes(Buffer.from(stdout, 'utf8')),
  }
  workload.workload_digest = portableVmAotWorkloadDigest(workload)
  return workload
}

function expectedExecutionFromReference(referenceWorkload) {
  return {
    artifact_digest: referenceWorkload.request.artifact_digest,
    graph_revision: referenceWorkload.request.graph_revision,
    invocations: structuredClone(referenceWorkload.result.receipt.invocations),
    outcome: structuredClone(referenceWorkload.result.outcome),
  }
}

function parseReceipt(stdout, expected) {
  let receipt
  try {
    receipt = JSON.parse(stdout)
  } catch {
    fail('portable-vm-aot-output-invalid')
  }
  if (!canonicalEqual(receipt, expected)
    || stdout !== `${canonicalJson(expected)}\n`) {
    fail('portable-vm-aot-semantic-mismatch')
  }
  return receipt
}

function compileExecutable({
  compiler_path,
  executablePath,
  sourcePath,
  target_triple,
}) {
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
    { encoding: 'utf8', shell: false },
  )
  if (built.error?.code === 'ENOENT') {
    fail('portable-vm-aot-compiler-missing')
  }
  if (built.error || built.status !== 0 || built.stderr !== '') {
    fail('portable-vm-aot-compile-failed')
  }
}

function runExecutable({ executablePath, request }) {
  const executed = spawnSync(executablePath, [], {
    encoding: 'utf8',
    input: `${canonicalJson(request)}\n`,
    shell: false,
  })
  if (executed.error || executed.status !== 0 || executed.stderr !== '') {
    fail('portable-vm-aot-execution-failed')
  }
  return executed
}

async function currentCompilerProvenance({ compiler_path, target_triple }) {
  if (!isAbsolute(compiler_path)) fail('portable-vm-aot-compiler-path-invalid')
  let compilerBytes
  let metadata
  try {
    compilerBytes = await readFile(compiler_path)
    metadata = await stat(compiler_path)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('portable-vm-aot-compiler-missing')
    throw error
  }
  if (!metadata.isFile()) fail('portable-vm-aot-compiler-invalid')
  const version = spawnSync(compiler_path, ['--version'], {
    encoding: 'utf8',
    shell: false,
  })
  if (version.error || version.status !== 0 || version.stdout.length === 0) {
    fail('portable-vm-aot-compiler-version-failed')
  }
  const compiler_digest = digestBytes(compilerBytes)
  const compiler_version_digest = digestBytes(
    Buffer.from(version.stdout, 'utf8'),
  )
  const operating_system = platform()
  const architecture = arch()
  const identity = {
    architecture,
    compiler_digest,
    compiler_path,
    compiler_version_digest,
    environment_id: `${operating_system}-${architecture}-portable-vm-aot`,
    operating_system,
    target_triple,
  }
  return {
    ...identity,
    host_identity_digest: digestValue({
      ...identity,
      release: release(),
    }),
    measurement_source: 'runner',
    runner_id: PORTABLE_VM_AOT_PROFILE,
    synthetic: false,
  }
}

function validateRunInput({
  bundle,
  compiler_path,
  loadGraph,
  release_lock_digest,
  samples,
  target_triple,
  toolchain_digest,
}) {
  if (!plainObject(bundle)
    || !Array.isArray(bundle.cases)
    || bundle.cases.length === 0
    || !isAbsolute(compiler_path)
    || typeof loadGraph !== 'function'
    || !DIGEST.test(release_lock_digest)
    || !DIGEST.test(toolchain_digest)
    || typeof target_triple !== 'string'
    || target_triple.length === 0
    || !Number.isSafeInteger(samples)
    || samples < 1
    || samples > 8) {
    fail('portable-vm-aot-input-invalid')
  }
}

function validateReport(report) {
  if (!plainObject(report)
    || !exactShape(report, REPORT_FIELDS)
    || report.schema !== PORTABLE_VM_AOT_REPORT_SCHEMA
    || report.profile !== PORTABLE_VM_AOT_PROFILE
    || report.candidate !== 'aot-llvm'
    || report.status !== 'measured'
    || !DIGEST.test(report.bundle_digest)
    || !DIGEST.test(report.release_lock_digest)
    || !DIGEST.test(report.report_digest)
    || !DIGEST.test(report.toolchain_digest)
    || typeof report.target_triple !== 'string'
    || report.target_triple.length === 0
    || !Array.isArray(report.workloads)) {
    fail('portable-vm-aot-report-invalid')
  }
  validateProvenance(report.provenance)
  for (const workload of report.workloads) {
    if (!plainObject(workload)
      || !exactShape(workload, WORKLOAD_FIELDS)
      || typeof workload.id !== 'string'
      || !DIGEST.test(workload.artifact_digest)
      || !DIGEST.test(workload.executable_digest)
      || !DIGEST.test(workload.receipt_digest)
      || !DIGEST.test(workload.request_digest)
      || !DIGEST.test(workload.source_digest)
      || !DIGEST.test(workload.stdout_digest)
      || !DIGEST.test(workload.workload_digest)
      || !plainObject(workload.execution)) {
      fail('portable-vm-aot-workload-invalid')
    }
  }
}

function validateProvenance(value) {
  if (!plainObject(value)
    || !exactShape(value, PROVENANCE_FIELDS)
    || typeof value.architecture !== 'string'
    || !DIGEST.test(value.compiler_digest)
    || !isAbsolute(value.compiler_path)
    || !DIGEST.test(value.compiler_version_digest)
    || typeof value.environment_id !== 'string'
    || !DIGEST.test(value.host_identity_digest)
    || value.measurement_source !== 'runner'
    || typeof value.operating_system !== 'string'
    || value.runner_id !== PORTABLE_VM_AOT_PROFILE
    || value.synthetic !== false
    || typeof value.target_triple !== 'string') {
    fail('portable-vm-aot-provenance-invalid')
  }
}

function validateDriverInputs({ artifact, receipt, request, transcript }) {
  if (!plainObject(artifact)
    || !Array.isArray(artifact.instructions)
    || artifact.instructions.length !== 4
    || !plainObject(receipt)
    || receipt.schema !== PORTABLE_VM_AOT_RECEIPT_SCHEMA
    || !plainObject(request)
    || !DIGEST.test(request.request_digest)
    || !Array.isArray(transcript)
    || transcript.length !== 1) {
    fail('portable-vm-aot-driver-input-invalid')
  }
  const [invoke, branch, okExit, errExit] = artifact.instructions
  const responseKind = transcript[0]?.response?.kind === 'value'
    ? transcript[0].response.value?.kind
    : null
  if (invoke.op !== 'invoke-capability'
    || branch.op !== 'branch-result'
    || okExit.op !== 'process-exit'
    || errExit.op !== 'process-exit'
    || !['ok', 'err'].includes(responseKind)) {
    fail('portable-vm-aot-opcode-unsupported')
  }
}

function normalizeTranscriptArguments(instance, member, arguments_) {
  if (typeof instance !== 'string'
    || typeof member !== 'string'
    || !plainObject(arguments_)) {
    fail('portable-vm-aot-transcript-arguments-invalid')
  }
  return arguments_
}

function encodedLiteral(literal) {
  if (!plainObject(literal) || typeof literal.type !== 'string') {
    fail('portable-vm-aot-literal-invalid')
  }
  return literal.type === 'bytes'
    ? { $bytes: literal.value }
    : literal.value
}

function exitCode(literal) {
  if (!plainObject(literal)
    || literal.type !== 'int'
    || typeof literal.value !== 'string'
    || !INTEGER.test(literal.value)) {
    fail('portable-vm-aot-exit-invalid')
  }
  const value = Number(BigInt(literal.value))
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    fail('portable-vm-aot-exit-invalid')
  }
  return value
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
  return Object.keys(value).sort().join(',')
    === [...fields].sort().join(',')
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(code, detail = {}) {
  throw Object.assign(new TypeError(code), { code, ...detail })
}

function rejected(code, detail = {}) {
  return { diagnostics: [{ code, ...detail }], ok: false }
}
