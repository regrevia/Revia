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

export const STANDALONE_PORTABLE_VM_PROFILE =
  're.standalone-portable-vm@0.1.0'
export const STANDALONE_PORTABLE_VM_WIRE_SCHEMA =
  're.standalone-portable-vm-wire@0.1.0'
export const STANDALONE_PORTABLE_VM_RECEIPT_SCHEMA =
  're.standalone-portable-vm-receipt@0.1.0'
export const STANDALONE_PORTABLE_VM_ERROR_SCHEMA =
  're.standalone-portable-vm-error@0.1.0'
export const STANDALONE_PORTABLE_VM_REPORT_SCHEMA =
  're.standalone-portable-vm-report@0.1.0'

const REQUEST_MAGIC = Buffer.from('REVMREQ1', 'ascii')
const RESPONSE_MAGIC = Buffer.from('REVMRES1', 'ascii')
const HEADER_BYTES = 44
const MAX_PAYLOAD_BYTES = 65_535
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const ERROR_CODES = Object.freeze({
  1: 'wire-truncated',
  2: 'wire-extra-bytes',
  3: 'wire-magic-mismatch',
  4: 'wire-length-invalid',
  5: 'wire-digest-mismatch',
  6: 'wire-version-mismatch',
  7: 'wire-opcode-invalid',
  8: 'wire-authority-mismatch',
  9: 'wire-field-invalid',
})

export async function runStandalonePortableVmConformance({
  bundle,
  compiler_path,
  loadGraph,
  release_lock_digest,
  target_triple,
  toolchain_digest,
} = {}) {
  let root = null
  try {
    validateInputs({
      bundle,
      compiler_path,
      loadGraph,
      release_lock_digest,
      target_triple,
      toolchain_digest,
    })
    const reference = await runPortableExecutorBenchmark(bundle, { loadGraph })
    if (!reference.ok) return reference
    const referenceWorkloads = reference.value.candidates[0].workloads
    root = await mkdtemp(join(tmpdir(), 're-standalone-portable-vm-'))
    const built = await buildExecutable({
      compiler_path,
      root,
      target_triple,
    })
    const workloads = []
    for (let index = 0; index < bundle.cases.length; index += 1) {
      const entry = bundle.cases[index]
      const graph = await loadGraph(entry)
      if (!plainObject(graph) || graph.graph_revision !== entry.graph_revision) {
        fail('standalone-portable-vm-graph-authority-mismatch')
      }
      const artifact = compilePortableBytecode(graph)
      if (!artifact.ok) return artifact
      const referenceWorkload = referenceWorkloads[index]
      const wire = buildStandalonePortableVmWire({
        artifact: artifact.value,
        request: referenceWorkload.request,
        transcript: entry.invocations,
      })
      const executed = executeWire(built.executable_path, wire)
      if (!executed.ok) return executed
      const receipt = createReceipt({
        parsed: executed.value,
        response_wire: executed.response_wire,
      })
      const expectedExecution = executionFromReference(referenceWorkload)
      if (!canonicalEqual(receipt.execution, expectedExecution)
        || receipt.artifact_digest !== artifact.value.artifact_digest
        || receipt.request_digest !== referenceWorkload.request.request_digest
        || receipt.workload_id !== entry.id) {
        fail('standalone-portable-vm-semantic-mismatch')
      }
      const workload = {
        artifact_digest: artifact.value.artifact_digest,
        executable_digest: built.executable_digest,
        id: entry.id,
        receipt,
        request_digest: referenceWorkload.request.request_digest,
        request_wire_digest: digestBytes(wire),
        response_wire_digest: digestBytes(executed.response_wire),
      }
      workload.workload_digest = standalonePortableVmWorkloadDigest(workload)
      workloads.push(workload)
    }
    const report = {
      bundle_digest: digestValue(bundle),
      candidate: 'standalone-c11',
      executable_digest: built.executable_digest,
      profile: STANDALONE_PORTABLE_VM_PROFILE,
      provenance: await compilerProvenance({ compiler_path, target_triple }),
      release_lock_digest,
      schema: STANDALONE_PORTABLE_VM_REPORT_SCHEMA,
      source_digest: built.source_digest,
      status: 'measured',
      target_triple,
      toolchain_digest,
      wire_schema: STANDALONE_PORTABLE_VM_WIRE_SCHEMA,
      workloads,
    }
    report.report_digest = standalonePortableVmReportDigest(report)
    const verified = await verifyStandalonePortableVmReport(report, {
      bundle,
      compiler_path,
      loadGraph,
      release_lock_digest,
      target_triple,
      toolchain_digest,
    })
    return verified.ok ? { ok: true, value: report } : verified
  } catch (error) {
    return rejected(error?.code ?? 'standalone-portable-vm-runner-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function verifyStandalonePortableVmReport(report, inputs = {}) {
  let root = null
  try {
    validateInputs(inputs)
    validateReport(report)
    if (report.bundle_digest !== digestValue(inputs.bundle)
      || report.release_lock_digest !== inputs.release_lock_digest
      || report.target_triple !== inputs.target_triple
      || report.toolchain_digest !== inputs.toolchain_digest
      || report.source_digest !== digestBytes(
        Buffer.from(standalonePortableVmCSource(), 'utf8'),
      )) {
      fail('standalone-portable-vm-report-authority-mismatch')
    }
    const provenance = await compilerProvenance(inputs)
    if (!canonicalEqual(report.provenance, provenance)) {
      fail('standalone-portable-vm-compiler-mismatch')
    }
    const reference = await runPortableExecutorBenchmark(
      inputs.bundle,
      { loadGraph: inputs.loadGraph },
    )
    if (!reference.ok) return reference
    root = await mkdtemp(join(tmpdir(), 're-standalone-portable-vm-verify-'))
    const built = await buildExecutable({
      compiler_path: inputs.compiler_path,
      root,
      target_triple: inputs.target_triple,
    })
    if (built.executable_digest !== report.executable_digest) {
      fail('standalone-portable-vm-executable-mismatch')
    }
    if (report.workloads.length !== inputs.bundle.cases.length) {
      fail('standalone-portable-vm-workload-set-mismatch')
    }
    for (let index = 0; index < inputs.bundle.cases.length; index += 1) {
      const entry = inputs.bundle.cases[index]
      const actual = report.workloads[index]
      const graph = await inputs.loadGraph(entry)
      const artifact = compilePortableBytecode(graph)
      if (!artifact.ok) return artifact
      const referenceWorkload = reference.value.candidates[0].workloads[index]
      const wire = buildStandalonePortableVmWire({
        artifact: artifact.value,
        request: referenceWorkload.request,
        transcript: entry.invocations,
      })
      const executed = executeWire(built.executable_path, wire)
      if (!executed.ok) return executed
      const receipt = createReceipt({
        parsed: executed.value,
        response_wire: executed.response_wire,
      })
      if (actual.id !== entry.id
        || actual.artifact_digest !== artifact.value.artifact_digest
        || actual.executable_digest !== report.executable_digest
        || actual.request_digest !== referenceWorkload.request.request_digest
        || actual.request_wire_digest !== digestBytes(wire)
        || actual.response_wire_digest !== digestBytes(executed.response_wire)
        || !canonicalEqual(actual.receipt, receipt)
        || !canonicalEqual(
          actual.receipt.execution,
          executionFromReference(referenceWorkload),
        )
        || actual.workload_digest
          !== standalonePortableVmWorkloadDigest(actual)) {
        fail('standalone-portable-vm-workload-authority-mismatch')
      }
    }
    if (report.report_digest !== standalonePortableVmReportDigest(report)) {
      fail('standalone-portable-vm-report-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-portable-vm-report-invalid')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function runStandalonePortableVmWire({
  compiler_path,
  target_triple,
  wire,
} = {}) {
  let root = null
  try {
    if (!isAbsolute(compiler_path)
      || typeof target_triple !== 'string'
      || !Buffer.isBuffer(wire)) {
      fail('standalone-portable-vm-input-invalid')
    }
    root = await mkdtemp(join(tmpdir(), 're-standalone-portable-vm-wire-'))
    const built = await buildExecutable({ compiler_path, root, target_triple })
    return executeWire(built.executable_path, wire)
  } catch (error) {
    return rejected(error?.code ?? 'standalone-portable-vm-wire-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export function buildStandalonePortableVmWire({
  artifact,
  request,
  transcript,
} = {}) {
  validateWireInputs({ artifact, request, transcript })
  const [invoke, branch, okExit, errExit] = artifact.instructions
  const entry = transcript[0]
  const responseKind = entry.response?.kind === 'value'
    ? entry.response.value?.kind
    : null
  const artifactArguments = Object.fromEntries(
    invoke.arguments.map(({ literal, name }) => [
      name,
      encodedLiteral(artifact.literals[literal]),
    ]),
  )
  const transcriptArguments = entry.arguments
  const fixed = Buffer.alloc(10)
  fixed.writeUInt16LE(1, 0)
  fixed.writeUInt8(4, 2)
  fixed.writeUInt8(responseKind === 'ok' ? 1 : 2, 3)
  fixed.writeUInt8(branch.ok, 4)
  fixed.writeUInt8(branch.err, 5)
  fixed.writeUInt8(exitCode(artifact.literals[okExit.code_literal]), 6)
  fixed.writeUInt8(exitCode(artifact.literals[errExit.code_literal]), 7)
  fixed.writeUInt16LE(0, 8)
  const payload = Buffer.concat([
    fixed,
    ...[
      artifact.artifact_digest,
      artifact.graph_revision,
      request.request_digest,
      request.workload_id,
      invoke.instance,
      invoke.member,
      invoke.invocation_id,
      canonicalJson(artifactArguments),
      entry.instance,
      entry.member,
      entry.invocation_id,
      canonicalJson(transcriptArguments),
    ].map(fieldBytes),
  ])
  return frame(REQUEST_MAGIC, payload)
}

export function standalonePortableVmReceiptDigest(receipt) {
  const { receipt_digest: ignored, ...content } = receipt
  return digestValue(content)
}

export function standalonePortableVmWorkloadDigest(workload) {
  const { workload_digest: ignored, ...content } = workload
  return digestValue(content)
}

export function standalonePortableVmReportDigest(report) {
  const { report_digest: ignored, ...content } = report
  return digestValue(content)
}

export function standalonePortableVmCSource() {
  return `${standalonePortableVmSha256CSource()}
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HEADER_SIZE 44u
#define MAX_PAYLOAD 65535u

static unsigned read_u16(const unsigned char *p) {
  return (unsigned)p[0] | ((unsigned)p[1] << 8);
}
static unsigned read_u32(const unsigned char *p) {
  return (unsigned)p[0] | ((unsigned)p[1] << 8)
    | ((unsigned)p[2] << 16) | ((unsigned)p[3] << 24);
}
static void write_u16(unsigned char *p, unsigned value) {
  p[0] = (unsigned char)(value & 255u);
  p[1] = (unsigned char)((value >> 8) & 255u);
}
static void write_u32(unsigned char *p, unsigned value) {
  p[0] = (unsigned char)(value & 255u);
  p[1] = (unsigned char)((value >> 8) & 255u);
  p[2] = (unsigned char)((value >> 16) & 255u);
  p[3] = (unsigned char)((value >> 24) & 255u);
}
static int digest_field(const unsigned char *p, unsigned n) {
  if (n != 71u || memcmp(p, "sha256:", 7u) != 0) return 0;
  for (unsigned i = 7u; i < n; i++) {
    if (!((p[i] >= '0' && p[i] <= '9') || (p[i] >= 'a' && p[i] <= 'f'))) return 0;
  }
  return 1;
}
static int field(const unsigned char *payload, unsigned size, unsigned *offset,
  const unsigned char **value, unsigned *length) {
  if (*offset + 2u > size) return 0;
  *length = read_u16(payload + *offset);
  *offset += 2u;
  if (*length > 4096u || *offset + *length > size) return 0;
  *value = payload + *offset;
  *offset += *length;
  return 1;
}
static int same(const unsigned char *a, unsigned an,
  const unsigned char *b, unsigned bn) {
  return an == bn && memcmp(a, b, an) == 0;
}
static int fail_wire(unsigned code) {
  printf("REVMERR1:%u\\n", code);
  return 70;
}
static int append_field(unsigned char *out, unsigned capacity, unsigned *offset,
  const unsigned char *value, unsigned length) {
  if (length > 4096u || *offset + 2u + length > capacity) return 0;
  write_u16(out + *offset, length);
  *offset += 2u;
  memcpy(out + *offset, value, length);
  *offset += length;
  return 1;
}
int main(void) {
  unsigned char input[HEADER_SIZE + MAX_PAYLOAD + 1u];
  size_t count = fread(input, 1u, sizeof(input), stdin);
  if (count < HEADER_SIZE) return fail_wire(1u);
  if (memcmp(input, "REVMREQ1", 8u) != 0) return fail_wire(3u);
  unsigned payload_size = read_u32(input + 8u);
  if (payload_size > MAX_PAYLOAD) return fail_wire(4u);
  if (count < HEADER_SIZE + payload_size) return fail_wire(1u);
  if (count > HEADER_SIZE + payload_size) return fail_wire(2u);
  unsigned char digest[32];
  sha256(input + HEADER_SIZE, payload_size, digest);
  if (memcmp(digest, input + 12u, 32u) != 0) return fail_wire(5u);
  const unsigned char *payload = input + HEADER_SIZE;
  if (payload_size < 10u || read_u16(payload) != 1u) return fail_wire(6u);
  unsigned opcode_count = payload[2], result = payload[3];
  unsigned ok_pc = payload[4], err_pc = payload[5];
  unsigned ok_exit = payload[6], err_exit = payload[7];
  if (opcode_count != 4u || (result != 1u && result != 2u)
      || ok_pc != 2u || err_pc != 3u || read_u16(payload + 8u) != 0u) {
    return fail_wire(7u);
  }
  const unsigned char *values[12];
  unsigned lengths[12], offset = 10u;
  for (unsigned i = 0u; i < 12u; i++) {
    if (!field(payload, payload_size, &offset, &values[i], &lengths[i])) {
      return fail_wire(9u);
    }
  }
  if (offset != payload_size || !digest_field(values[0], lengths[0])
      || !digest_field(values[1], lengths[1])
      || !digest_field(values[2], lengths[2])) return fail_wire(9u);
  if (!same(values[4], lengths[4], values[8], lengths[8])
      || !same(values[5], lengths[5], values[9], lengths[9])
      || !same(values[6], lengths[6], values[10], lengths[10])
      || !same(values[7], lengths[7], values[11], lengths[11])) {
    return fail_wire(8u);
  }
  unsigned pc = 0u, exit_code = 256u;
  for (;;) {
    if (pc == 0u) { pc = 1u; continue; }
    if (pc == 1u) { pc = result == 1u ? ok_pc : err_pc; continue; }
    if (pc == ok_pc) { exit_code = ok_exit; break; }
    if (pc == err_pc) { exit_code = err_exit; break; }
    return fail_wire(7u);
  }
  unsigned char response[MAX_PAYLOAD];
  unsigned response_size = 0u;
  write_u16(response + response_size, 1u); response_size += 2u;
  response[response_size++] = (unsigned char)exit_code;
  response[response_size++] = (unsigned char)result;
  const unsigned indices[] = {0u, 1u, 2u, 3u, 4u, 5u, 6u};
  for (unsigned i = 0u; i < 7u; i++) {
    unsigned index = indices[i];
    if (!append_field(response, MAX_PAYLOAD, &response_size,
        values[index], lengths[index])) return fail_wire(9u);
  }
  unsigned char header[HEADER_SIZE];
  memcpy(header, "REVMRES1", 8u);
  write_u32(header + 8u, response_size);
  sha256(response, response_size, header + 12u);
  if (fwrite(header, 1u, HEADER_SIZE, stdout) != HEADER_SIZE
      || fwrite(response, 1u, response_size, stdout) != response_size) return 74;
  return 0;
}
`
}

async function buildExecutable({ compiler_path, root, target_triple }) {
  const source = standalonePortableVmCSource()
  const source_path = join(root, 'standalone-portable-vm.c')
  const executable_path = join(
    root,
    platform() === 'win32'
      ? 'standalone-portable-vm.exe'
      : 'standalone-portable-vm',
  )
  await writeFile(source_path, source, 'utf8')
  const built = spawnSync(compiler_path, [
    '-O2',
    '-std=c11',
    '-target',
    target_triple,
    source_path,
    '-o',
    executable_path,
  ], { encoding: 'utf8', shell: false })
  if (built.error?.code === 'ENOENT') fail('standalone-portable-vm-compiler-missing')
  if (built.error || built.status !== 0) {
    fail('standalone-portable-vm-compile-failed')
  }
  return {
    executable_digest: digestBytes(await readFile(executable_path)),
    executable_path,
    source_digest: digestBytes(Buffer.from(source, 'utf8')),
  }
}

function executeWire(executable_path, wire) {
  const executed = spawnSync(executable_path, [], {
    encoding: null,
    input: wire,
    maxBuffer: 1024 * 1024,
    shell: false,
  })
  const stdout = Buffer.from(executed.stdout ?? [])
  if (executed.status !== 0) {
    const match = stdout.toString('ascii').match(/^REVMERR1:([0-9]+)\n$/u)
    return rejected(ERROR_CODES[Number(match?.[1])]
      ?? 'standalone-portable-vm-execution-failed')
  }
  if (executed.error || Buffer.from(executed.stderr ?? []).length !== 0) {
    return rejected('standalone-portable-vm-execution-failed')
  }
  try {
    return {
      ok: true,
      response_wire: stdout,
      value: parseResponseWire(stdout),
    }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-portable-vm-response-invalid')
  }
}

function parseResponseWire(wire) {
  if (wire.length < HEADER_BYTES) fail('standalone-portable-vm-response-truncated')
  if (!wire.subarray(0, 8).equals(RESPONSE_MAGIC)) {
    fail('standalone-portable-vm-response-magic-mismatch')
  }
  const length = wire.readUInt32LE(8)
  if (wire.length !== HEADER_BYTES + length || length > MAX_PAYLOAD_BYTES) {
    fail('standalone-portable-vm-response-length-mismatch')
  }
  const payload = wire.subarray(HEADER_BYTES)
  if (!sha256(payload).equals(wire.subarray(12, 44))) {
    fail('standalone-portable-vm-response-digest-mismatch')
  }
  if (payload.length < 4 || payload.readUInt16LE(0) !== 1) {
    fail('standalone-portable-vm-response-version-mismatch')
  }
  let offset = 4
  const fields = []
  for (let index = 0; index < 7; index += 1) {
    if (offset + 2 > payload.length) fail('standalone-portable-vm-response-invalid')
    const size = payload.readUInt16LE(offset)
    offset += 2
    if (size > 4096 || offset + size > payload.length) {
      fail('standalone-portable-vm-response-invalid')
    }
    fields.push(payload.subarray(offset, offset + size).toString('utf8'))
    offset += size
  }
  if (offset !== payload.length || !fields.slice(0, 3).every(
    (value) => DIGEST.test(value),
  )) fail('standalone-portable-vm-response-invalid')
  const [artifact_digest, graph_revision, request_digest, workload_id,
    instance, member, invocation_id] = fields
  return {
    artifact_digest,
    graph_revision,
    invocation_id,
    instance,
    member,
    outcome_code: payload[2],
    request_digest,
    transcript_result: payload[3],
    workload_id,
  }
}

function createReceipt({ parsed, response_wire }) {
  const receipt = {
    artifact_digest: parsed.artifact_digest,
    execution: {
      artifact_digest: parsed.artifact_digest,
      graph_revision: parsed.graph_revision,
      invocations: [{
        instance: parsed.instance,
        invocation_id: parsed.invocation_id,
        member: parsed.member,
        outcome: parsed.transcript_result === 1 ? 'ok' : 'err',
      }],
      outcome: { code: parsed.outcome_code, type: 'process.status' },
    },
    graph_revision: parsed.graph_revision,
    profile: STANDALONE_PORTABLE_VM_PROFILE,
    request_digest: parsed.request_digest,
    response_wire_digest: digestBytes(response_wire),
    schema: STANDALONE_PORTABLE_VM_RECEIPT_SCHEMA,
    status: 'ok',
    workload_id: parsed.workload_id,
  }
  receipt.receipt_digest = standalonePortableVmReceiptDigest(receipt)
  return receipt
}

function frame(magic, payload) {
  if (payload.length > MAX_PAYLOAD_BYTES) {
    fail('standalone-portable-vm-wire-payload-too-large')
  }
  const header = Buffer.alloc(HEADER_BYTES)
  magic.copy(header, 0)
  header.writeUInt32LE(payload.length, 8)
  sha256(payload).copy(header, 12)
  return Buffer.concat([header, payload])
}

function fieldBytes(value) {
  if (typeof value !== 'string') fail('standalone-portable-vm-wire-field-invalid')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > 4096) fail('standalone-portable-vm-wire-field-invalid')
  const length = Buffer.alloc(2)
  length.writeUInt16LE(bytes.length)
  return Buffer.concat([length, bytes])
}

function validateWireInputs({ artifact, request, transcript }) {
  if (!plainObject(artifact)
    || !Array.isArray(artifact.instructions)
    || artifact.instructions.length !== 4
    || !DIGEST.test(artifact.artifact_digest)
    || !DIGEST.test(artifact.graph_revision)
    || !plainObject(request)
    || !DIGEST.test(request.request_digest)
    || request.artifact_digest !== artifact.artifact_digest
    || request.graph_revision !== artifact.graph_revision
    || !Array.isArray(transcript)
    || transcript.length !== 1) {
    fail('standalone-portable-vm-wire-input-invalid')
  }
  const [invoke, branch, okExit, errExit] = artifact.instructions
  const responseKind = transcript[0]?.response?.kind === 'value'
    ? transcript[0].response.value?.kind
    : null
  if (invoke.op !== 'invoke-capability'
    || branch.op !== 'branch-result'
    || branch.ok !== 2
    || branch.err !== 3
    || okExit.op !== 'process-exit'
    || errExit.op !== 'process-exit'
    || !['ok', 'err'].includes(responseKind)) {
    fail('standalone-portable-vm-wire-opcode-unsupported')
  }
}

function validateInputs({
  bundle,
  compiler_path,
  loadGraph,
  release_lock_digest,
  target_triple,
  toolchain_digest,
}) {
  if (!plainObject(bundle)
    || !Array.isArray(bundle.cases)
    || bundle.cases.length !== 9
    || !isAbsolute(compiler_path)
    || typeof loadGraph !== 'function'
    || !DIGEST.test(release_lock_digest)
    || !DIGEST.test(toolchain_digest)
    || typeof target_triple !== 'string'
    || target_triple.length === 0) {
    fail('standalone-portable-vm-input-invalid')
  }
}

function validateReport(report) {
  if (!plainObject(report)
    || report.schema !== STANDALONE_PORTABLE_VM_REPORT_SCHEMA
    || report.profile !== STANDALONE_PORTABLE_VM_PROFILE
    || report.candidate !== 'standalone-c11'
    || report.status !== 'measured'
    || report.wire_schema !== STANDALONE_PORTABLE_VM_WIRE_SCHEMA
    || !DIGEST.test(report.bundle_digest)
    || !DIGEST.test(report.executable_digest)
    || !DIGEST.test(report.release_lock_digest)
    || !DIGEST.test(report.report_digest)
    || !DIGEST.test(report.source_digest)
    || !DIGEST.test(report.toolchain_digest)
    || !Array.isArray(report.workloads)) {
    fail('standalone-portable-vm-report-invalid')
  }
}

async function compilerProvenance({ compiler_path, target_triple }) {
  let bytes
  let metadata
  try {
    bytes = await readFile(compiler_path)
    metadata = await stat(compiler_path)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('standalone-portable-vm-compiler-missing')
    throw error
  }
  if (!metadata.isFile()) fail('standalone-portable-vm-compiler-invalid')
  const version = spawnSync(compiler_path, ['--version'], {
    encoding: 'utf8',
    shell: false,
  })
  if (version.error || version.status !== 0 || version.stdout.length === 0) {
    fail('standalone-portable-vm-compiler-version-failed')
  }
  const identity = {
    architecture: arch(),
    compiler_digest: digestBytes(bytes),
    compiler_path,
    compiler_version_digest: digestBytes(Buffer.from(version.stdout, 'utf8')),
    environment_id: `${platform()}-${arch()}-standalone-portable-vm`,
    operating_system: platform(),
    target_triple,
  }
  return {
    ...identity,
    host_identity_digest: digestValue({ ...identity, release: release() }),
    measurement_source: 'runner',
    runner_id: STANDALONE_PORTABLE_VM_PROFILE,
    synthetic: false,
  }
}

function executionFromReference(workload) {
  return {
    artifact_digest: workload.request.artifact_digest,
    graph_revision: workload.request.graph_revision,
    invocations: structuredClone(workload.result.receipt.invocations),
    outcome: structuredClone(workload.result.outcome),
  }
}

function encodedLiteral(literal) {
  return literal.type === 'bytes' ? { $bytes: literal.value } : literal.value
}

function exitCode(literal) {
  const value = Number(BigInt(literal.value))
  if (literal.type !== 'int'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > 255) {
    fail('standalone-portable-vm-exit-invalid')
  }
  return value
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest()
}

function digestBytes(bytes) {
  return `sha256:${sha256(bytes).toString('hex')}`
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

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}

export function standalonePortableVmSha256CSource() {
  return `#include <stdint.h>
#include <stddef.h>
typedef struct { uint32_t h[8]; uint64_t bits; unsigned char block[64]; size_t used; } sha256_ctx;
static uint32_t rr(uint32_t x, unsigned n) { return (x >> n) | (x << (32u - n)); }
static const uint32_t kk[64] = {
0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
static void sha256_block(sha256_ctx *c, const unsigned char *p) {
  uint32_t w[64],a,b,d,e,f,g,h,t1,t2,cc;
  for (unsigned i=0;i<16;i++) w[i]=((uint32_t)p[i*4]<<24)|((uint32_t)p[i*4+1]<<16)|((uint32_t)p[i*4+2]<<8)|p[i*4+3];
  for (unsigned i=16;i<64;i++){uint32_t x=w[i-15],y=w[i-2];w[i]=(rr(x,7)^rr(x,18)^(x>>3))+w[i-16]+(rr(y,17)^rr(y,19)^(y>>10))+w[i-7];}
  a=c->h[0];b=c->h[1];cc=c->h[2];d=c->h[3];e=c->h[4];f=c->h[5];g=c->h[6];h=c->h[7];
  for(unsigned i=0;i<64;i++){t1=h+(rr(e,6)^rr(e,11)^rr(e,25))+((e&f)^((~e)&g))+kk[i]+w[i];t2=(rr(a,2)^rr(a,13)^rr(a,22))+((a&b)^(a&cc)^(b&cc));h=g;g=f;f=e;e=d+t1;d=cc;cc=b;b=a;a=t1+t2;}
  c->h[0]+=a;c->h[1]+=b;c->h[2]+=cc;c->h[3]+=d;c->h[4]+=e;c->h[5]+=f;c->h[6]+=g;c->h[7]+=h;
}
static void sha256_init(sha256_ctx *c){uint32_t h[8]={0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};for(unsigned i=0;i<8;i++)c->h[i]=h[i];c->bits=0;c->used=0;}
static void sha256_update(sha256_ctx *c,const unsigned char *p,size_t n){c->bits+=(uint64_t)n*8u;while(n){size_t take=64u-c->used;if(take>n)take=n;for(size_t i=0;i<take;i++)c->block[c->used+i]=p[i];c->used+=take;p+=take;n-=take;if(c->used==64u){sha256_block(c,c->block);c->used=0;}}}
static void sha256_final(sha256_ctx *c,unsigned char out[32]){c->block[c->used++]=0x80u;if(c->used>56u){while(c->used<64u)c->block[c->used++]=0;sha256_block(c,c->block);c->used=0;}while(c->used<56u)c->block[c->used++]=0;for(unsigned i=0;i<8;i++)c->block[63u-i]=(unsigned char)(c->bits>>(i*8u));sha256_block(c,c->block);for(unsigned i=0;i<8;i++){out[i*4]=(unsigned char)(c->h[i]>>24);out[i*4+1]=(unsigned char)(c->h[i]>>16);out[i*4+2]=(unsigned char)(c->h[i]>>8);out[i*4+3]=(unsigned char)c->h[i];}}
static void sha256(const unsigned char *p,size_t n,unsigned char out[32]){sha256_ctx c;sha256_init(&c);sha256_update(&c,p,n);sha256_final(&c,out);}
`
}
