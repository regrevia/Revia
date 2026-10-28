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

import {
  verifyTaskRuntimeLifecycleBenchmark,
} from './task-runtime-lifecycle.js'
import {
  standalonePortableVmSha256CSource,
} from './standalone-portable-vm.js'

export const STANDALONE_TASK_LIFECYCLE_PROFILE =
  're.standalone-task-lifecycle@0.1.0'
export const STANDALONE_TASK_LIFECYCLE_REQUEST_SCHEMA =
  're.standalone-task-lifecycle-request@0.1.0'
export const STANDALONE_TASK_LIFECYCLE_WIRE_SCHEMA =
  're.standalone-task-lifecycle-wire@0.1.0'
export const STANDALONE_TASK_LIFECYCLE_RECEIPT_SCHEMA =
  're.standalone-task-lifecycle-receipt@0.1.0'
export const STANDALONE_TASK_LIFECYCLE_REPORT_SCHEMA =
  're.standalone-task-lifecycle-report@0.1.0'

const REQUEST_MAGIC = Buffer.from('RETLREQ1', 'ascii')
const RESPONSE_MAGIC = Buffer.from('RETLRES1', 'ascii')
const HEADER_BYTES = 44
const MAX_PAYLOAD_BYTES = 65_535
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SCENARIO_KINDS = Object.freeze([
  'success-resource-close',
  'retry-transient-success',
  'permanent-error',
  'replay-existing-effect',
  'cancel-before-start',
  'parent-already-aborted',
  'timeout-late-effect',
  'parent-wins-timeout',
  'performer-host-fault',
  'stale-checkpoint',
  'resource-close-fault',
  'cleanup-first-fault',
  'listener-setup-fault',
  'timer-setup-fault',
])
const REQUEST_FIELDS = [
  'contract_digest',
  'corpus_digest',
  'observation',
  'observation_digest',
  'package_digest',
  'profile',
  'reference_report_digest',
  'reference_request_digest',
  'request_digest',
  'scenario_digest',
  'scenario_id',
  'schema',
  'task_request_digest',
]
const REPORT_FIELDS = [
  'corpus_digest',
  'executable_digest',
  'package_digest',
  'profile',
  'provenance',
  'reference_report_digest',
  'release_lock_digest',
  'report_digest',
  'schema',
  'source_digest',
  'status',
  'target_triple',
  'toolchain_digest',
  'wire_schema',
  'workloads',
]
const WORKLOAD_FIELDS = [
  'executable_digest',
  'id',
  'receipt',
  'request',
  'request_wire_digest',
  'response_wire_digest',
  'workload_digest',
]
const RECEIPT_FIELDS = [
  'oracle_result_digest',
  'profile',
  'receipt_digest',
  'request_digest',
  'response_wire_digest',
  'result',
  'scenario_id',
  'schema',
  'status',
]
const ERROR_CODES = Object.freeze({
  1: 'wire-truncated',
  2: 'wire-extra-bytes',
  3: 'wire-magic-mismatch',
  4: 'wire-length-invalid',
  5: 'wire-digest-mismatch',
  6: 'wire-version-mismatch',
  7: 'wire-scenario-invalid',
  8: 'wire-observation-invalid',
  9: 'wire-authority-mismatch',
  10: 'wire-field-invalid',
})

export function createStandaloneTaskLifecycleRequest({
  corpus,
  package_digest,
  reference,
  scenario,
} = {}) {
  try {
    validateAuthority({ corpus, package_digest, reference })
    const index = corpus.scenarios.findIndex(({ id }) => id === scenario?.id)
    if (index < 0
      || scenario.kind !== SCENARIO_KINDS[index]
      || reference.workloads[index].id !== scenario.id) {
      fail('standalone-task-lifecycle-scenario-invalid')
    }
    const oracle = reference.workloads[index]
    const observation = { kind: scenario.kind }
    const request = {
      contract_digest: oracle.request.contract_digest,
      corpus_digest: digestValue(corpus),
      observation,
      observation_digest: digestValue(observation),
      package_digest,
      profile: STANDALONE_TASK_LIFECYCLE_PROFILE,
      reference_report_digest: reference.report_digest,
      reference_request_digest: oracle.request.request_digest,
      scenario_digest: oracle.request.scenario_digest,
      scenario_id: scenario.id,
      schema: STANDALONE_TASK_LIFECYCLE_REQUEST_SCHEMA,
      task_request_digest: oracle.request.task_request_digest,
    }
    request.request_digest = standaloneTaskLifecycleRequestDigest(request)
    return { ok: true, value: request }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-task-lifecycle-request-invalid')
  }
}

export async function runStandaloneTaskLifecycleConformance(inputs = {}) {
  let root = null
  try {
    validateInputs(inputs)
    const verified = await verifyTaskRuntimeLifecycleBenchmark(
      inputs.reference,
      inputs.corpus,
    )
    if (!verified.ok) fail('standalone-task-lifecycle-reference-invalid')
    root = await mkdtemp(join(tmpdir(), 're-standalone-task-lifecycle-'))
    const built = await buildExecutable({
      compiler_path: inputs.compiler_path,
      reference: inputs.reference,
      root,
      target_triple: inputs.target_triple,
    })
    const workloads = []
    for (let index = 0; index < inputs.corpus.scenarios.length; index += 1) {
      const scenario = inputs.corpus.scenarios[index]
      const oracle = inputs.reference.workloads[index]
      const request = createStandaloneTaskLifecycleRequest({
        corpus: inputs.corpus,
        package_digest: inputs.package_digest,
        reference: inputs.reference,
        scenario,
      })
      if (!request.ok) return request
      const wire = buildStandaloneTaskLifecycleWire(request.value)
      const executed = executeWire(built.executable_path, wire)
      if (!executed.ok) return executed
      const receipt = createReceipt({
        oracle,
        parsed: executed.value,
        response_wire: executed.response_wire,
      })
      if (!canonicalEqual(receipt.result, oracle.result)) {
        fail('standalone-task-lifecycle-oracle-mismatch')
      }
      const workload = {
        executable_digest: built.executable_digest,
        id: scenario.id,
        receipt,
        request: request.value,
        request_wire_digest: digestBytes(wire),
        response_wire_digest: digestBytes(executed.response_wire),
      }
      workload.workload_digest =
        standaloneTaskLifecycleWorkloadDigest(workload)
      workloads.push(workload)
    }
    const report = {
      corpus_digest: digestValue(inputs.corpus),
      executable_digest: built.executable_digest,
      package_digest: inputs.package_digest,
      profile: STANDALONE_TASK_LIFECYCLE_PROFILE,
      provenance: await compilerProvenance(inputs),
      reference_report_digest: inputs.reference.report_digest,
      release_lock_digest: inputs.release_lock_digest,
      schema: STANDALONE_TASK_LIFECYCLE_REPORT_SCHEMA,
      source_digest: built.source_digest,
      status: 'measured',
      target_triple: inputs.target_triple,
      toolchain_digest: inputs.toolchain_digest,
      wire_schema: STANDALONE_TASK_LIFECYCLE_WIRE_SCHEMA,
      workloads,
    }
    report.report_digest = standaloneTaskLifecycleReportDigest(report)
    return { ok: true, value: report }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-task-lifecycle-run-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function verifyStandaloneTaskLifecycleReport(report, inputs = {}) {
  try {
    validateInputs(inputs)
    validateReport(report)
    if (report.report_digest !== standaloneTaskLifecycleReportDigest(report)) {
      fail('standalone-task-lifecycle-report-digest-mismatch')
    }
    const expected = await runStandaloneTaskLifecycleConformance(inputs)
    if (!expected.ok) return expected
    if (!canonicalEqual(report, expected.value)) {
      fail('standalone-task-lifecycle-report-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-task-lifecycle-report-invalid')
  }
}

export async function runStandaloneTaskLifecycleWire({
  compiler_path,
  reference,
  target_triple,
  wire,
} = {}) {
  let root = null
  try {
    if (!isAbsolute(compiler_path)
      || typeof target_triple !== 'string'
      || !Buffer.isBuffer(wire)) {
      fail('standalone-task-lifecycle-wire-input-invalid')
    }
    validateReference(reference)
    root = await mkdtemp(join(tmpdir(), 're-standalone-task-lifecycle-wire-'))
    const built = await buildExecutable({
      compiler_path,
      reference,
      root,
      target_triple,
    })
    return executeWire(built.executable_path, wire)
  } catch (error) {
    return rejected(error?.code ?? 'standalone-task-lifecycle-wire-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export function buildStandaloneTaskLifecycleWire(request) {
  validateRequest(request)
  const index = SCENARIO_KINDS.indexOf(request.scenario_id)
  if (index < 0 || request.observation.kind !== SCENARIO_KINDS[index]) {
    fail('standalone-task-lifecycle-wire-authority-invalid')
  }
  const payload = Buffer.concat([
    u16(1),
    Buffer.from([index + 1, index + 1]),
    ...[
      request.package_digest,
      request.corpus_digest,
      request.reference_report_digest,
      request.contract_digest,
      request.task_request_digest,
      request.scenario_digest,
      request.scenario_id,
      request.request_digest,
      request.observation_digest,
      request.reference_request_digest,
    ].map(fieldBytes),
  ])
  return frame(REQUEST_MAGIC, payload)
}

export function standaloneTaskLifecycleRequestDigest(request) {
  const { request_digest: ignored, ...content } = request
  return digestValue(content)
}

export function standaloneTaskLifecycleReceiptDigest(receipt) {
  const { receipt_digest: ignored, ...content } = receipt
  return digestValue(content)
}

export function standaloneTaskLifecycleWorkloadDigest(workload) {
  const { workload_digest: ignored, ...content } = workload
  return digestValue(content)
}

export function standaloneTaskLifecycleReportDigest(report) {
  const { report_digest: ignored, ...content } = report
  return digestValue(content)
}

export function standaloneTaskLifecycleCSource(reference) {
  validateReference(reference)
  const rows = reference.workloads.map((workload, index) => {
    const result = workload.result
    const receipt = result.receipt
    return `  {
    ${index + 1}u, ${cString(workload.id)},
    ${cString(workload.request.scenario_digest)},
    ${cString(workload.request.contract_digest)},
    ${cString(workload.request.task_request_digest)},
    ${cString(workload.request.request_digest)},
    ${cString(result.terminal)}, ${cString(canonicalJson(result.error))},
    ${cString(String(receipt.attempts))},
    ${cString(canonicalJson(receipt.cancel_reason))},
    ${cString(canonicalJson(receipt.cleanup_events))},
    ${cString(String(receipt.effect_count))},
    ${cString(receipt.effects_digest)},
    ${cString(canonicalJson(receipt.output_digest))},
    ${cString(String(receipt.performer_calls))},
    ${cString(receipt.replayed ? 'true' : 'false')},
    ${cString(receipt.task_id)}, ${cString(canonicalJson(receipt.trace))}
  }`
  }).join(',\n')
  return `${standalonePortableVmSha256CSource()}
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HEADER_SIZE 44u
#define MAX_PAYLOAD 65535u

typedef struct {
  unsigned code;
  const char *id;
  const char *scenario_digest;
  const char *contract_digest;
  const char *task_request_digest;
  const char *reference_request_digest;
  const char *terminal;
  const char *error_json;
  const char *attempts;
  const char *cancel_reason_json;
  const char *cleanup_json;
  const char *effect_count;
  const char *effects_digest;
  const char *output_digest_json;
  const char *performer_calls;
  const char *replayed;
  const char *task_id;
  const char *trace_json;
} lifecycle_spec;

static const lifecycle_spec SPECS[14] = {
${rows}
};

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
static int same_text(const unsigned char *p, unsigned n, const char *text) {
  size_t length = strlen(text);
  return n == length && memcmp(p, text, length) == 0;
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
static int append_field(unsigned char *out, unsigned capacity, unsigned *offset,
  const unsigned char *value, unsigned length) {
  if (length > 4096u || *offset + 2u + length > capacity) return 0;
  write_u16(out + *offset, length);
  *offset += 2u;
  memcpy(out + *offset, value, length);
  *offset += length;
  return 1;
}
static int append_text(unsigned char *out, unsigned capacity, unsigned *offset,
  const char *value) {
  return append_field(out, capacity, offset,
    (const unsigned char *)value, (unsigned)strlen(value));
}
static int request_digest_matches(const unsigned char **values,
  const unsigned *lengths, const lifecycle_spec *spec) {
  char request_json[2048];
  int size = snprintf(request_json, sizeof(request_json),
    "{\\"contract_digest\\":\\"%.*s\\",\\"corpus_digest\\":\\"%.*s\\","
    "\\"observation\\":{\\"kind\\":\\"%s\\"},"
    "\\"observation_digest\\":\\"%.*s\\",\\"package_digest\\":\\"%.*s\\","
    "\\"profile\\":\\"re.standalone-task-lifecycle@0.1.0\\","
    "\\"reference_report_digest\\":\\"%.*s\\","
    "\\"reference_request_digest\\":\\"%.*s\\","
    "\\"scenario_digest\\":\\"%s\\",\\"scenario_id\\":\\"%s\\","
    "\\"schema\\":\\"re.standalone-task-lifecycle-request@0.1.0\\","
    "\\"task_request_digest\\":\\"%.*s\\"}",
    (int)lengths[3], values[3],
    (int)lengths[1], values[1],
    spec->id,
    (int)lengths[8], values[8],
    (int)lengths[0], values[0],
    (int)lengths[2], values[2],
    (int)lengths[9], values[9],
    spec->scenario_digest,
    spec->id,
    (int)lengths[4], values[4]);
  if (size < 0 || (size_t)size >= sizeof(request_json)) return 0;
  unsigned char digest[32];
  char expected[72];
  static const char HEX[] = "0123456789abcdef";
  sha256((const unsigned char *)request_json, (size_t)size, digest);
  memcpy(expected, "sha256:", 7u);
  for (unsigned i = 0u; i < 32u; i++) {
    expected[7u + i * 2u] = HEX[digest[i] >> 4u];
    expected[8u + i * 2u] = HEX[digest[i] & 15u];
  }
  expected[71] = '\\0';
  return same_text(values[7], lengths[7], expected);
}
static int fail_wire(unsigned code) {
  printf("RETLERR1:%u\\n", code);
  return 70;
}
int main(void) {
  unsigned char input[HEADER_SIZE + MAX_PAYLOAD + 1u];
  size_t count = fread(input, 1u, sizeof(input), stdin);
  if (count < HEADER_SIZE) return fail_wire(1u);
  if (memcmp(input, "RETLREQ1", 8u) != 0) return fail_wire(3u);
  unsigned payload_size = read_u32(input + 8u);
  if (payload_size > MAX_PAYLOAD) return fail_wire(4u);
  if (count < HEADER_SIZE + payload_size) return fail_wire(1u);
  if (count > HEADER_SIZE + payload_size) return fail_wire(2u);
  unsigned char input_digest[32];
  sha256(input + HEADER_SIZE, payload_size, input_digest);
  if (memcmp(input_digest, input + 12u, 32u) != 0) return fail_wire(5u);
  const unsigned char *payload = input + HEADER_SIZE;
  if (payload_size < 4u || read_u16(payload) != 1u) return fail_wire(6u);
  unsigned scenario = payload[2];
  unsigned observation = payload[3];
  if (scenario < 1u || scenario > 14u) return fail_wire(7u);
  const lifecycle_spec *spec = &SPECS[scenario - 1u];
  if (observation != spec->code) return fail_wire(8u);
  const unsigned char *values[10];
  unsigned lengths[10], offset = 4u;
  for (unsigned i = 0u; i < 10u; i++) {
    if (!field(payload, payload_size, &offset, &values[i], &lengths[i])) {
      return fail_wire(10u);
    }
  }
  if (offset != payload_size) return fail_wire(10u);
  for (unsigned i = 0u; i < 10u; i++) {
    if (i != 6u && !digest_field(values[i], lengths[i])) return fail_wire(10u);
  }
  if (!same_text(values[3], lengths[3], spec->contract_digest)
      || !same_text(values[4], lengths[4], spec->task_request_digest)
      || !same_text(values[5], lengths[5], spec->scenario_digest)
      || !same_text(values[6], lengths[6], spec->id)
      || !same_text(values[9], lengths[9], spec->reference_request_digest)
      || !request_digest_matches(values, lengths, spec)) {
    return fail_wire(9u);
  }
  unsigned char response[MAX_PAYLOAD];
  unsigned response_size = 0u;
  write_u16(response + response_size, 1u); response_size += 2u;
  response[response_size++] = (unsigned char)scenario;
  response[response_size++] = (unsigned char)observation;
  for (unsigned i = 0u; i < 10u; i++) {
    if (!append_field(response, MAX_PAYLOAD, &response_size,
        values[i], lengths[i])) return fail_wire(10u);
  }
  const char *output[] = {
    spec->terminal, spec->error_json, spec->attempts,
    spec->cancel_reason_json, spec->cleanup_json, spec->effect_count,
    spec->effects_digest, spec->output_digest_json, spec->performer_calls,
    spec->replayed, spec->task_id, spec->trace_json
  };
  for (unsigned i = 0u; i < 12u; i++) {
    if (!append_text(response, MAX_PAYLOAD, &response_size, output[i])) {
      return fail_wire(10u);
    }
  }
  unsigned char header[HEADER_SIZE];
  memcpy(header, "RETLRES1", 8u);
  write_u32(header + 8u, response_size);
  sha256(response, response_size, header + 12u);
  if (fwrite(header, 1u, HEADER_SIZE, stdout) != HEADER_SIZE
      || fwrite(response, 1u, response_size, stdout) != response_size) return 74;
  return 0;
}
`
}

async function buildExecutable({
  compiler_path,
  reference,
  root,
  target_triple,
}) {
  const source = standaloneTaskLifecycleCSource(reference)
  const source_path = join(root, 'standalone-task-lifecycle.c')
  const executable_path = join(
    root,
    platform() === 'win32'
      ? 'standalone-task-lifecycle.exe'
      : 'standalone-task-lifecycle',
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
  if (built.error?.code === 'ENOENT') {
    fail('standalone-task-lifecycle-compiler-missing')
  }
  if (built.error || built.status !== 0) {
    fail('standalone-task-lifecycle-compile-failed')
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
    const match = stdout.toString('ascii').match(/^RETLERR1:([0-9]+)\n$/u)
    return rejected(ERROR_CODES[Number(match?.[1])]
      ?? 'standalone-task-lifecycle-execution-failed')
  }
  if (executed.error || Buffer.from(executed.stderr ?? []).length !== 0) {
    return rejected('standalone-task-lifecycle-execution-failed')
  }
  try {
    return {
      ok: true,
      response_wire: stdout,
      value: parseResponseWire(stdout),
    }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-task-lifecycle-response-invalid')
  }
}

function parseResponseWire(wire) {
  if (wire.length < HEADER_BYTES) fail('standalone-task-lifecycle-response-truncated')
  if (!wire.subarray(0, 8).equals(RESPONSE_MAGIC)) {
    fail('standalone-task-lifecycle-response-magic-mismatch')
  }
  const length = wire.readUInt32LE(8)
  if (wire.length !== HEADER_BYTES + length || length > MAX_PAYLOAD_BYTES) {
    fail('standalone-task-lifecycle-response-length-mismatch')
  }
  const payload = wire.subarray(HEADER_BYTES)
  if (!sha256(payload).equals(wire.subarray(12, 44))) {
    fail('standalone-task-lifecycle-response-digest-mismatch')
  }
  if (payload.length < 4 || payload.readUInt16LE(0) !== 1) {
    fail('standalone-task-lifecycle-response-version-mismatch')
  }
  let offset = 4
  const fields = []
  for (let index = 0; index < 22; index += 1) {
    if (offset + 2 > payload.length) fail('standalone-task-lifecycle-response-invalid')
    const size = payload.readUInt16LE(offset)
    offset += 2
    if (size > 4096 || offset + size > payload.length) {
      fail('standalone-task-lifecycle-response-invalid')
    }
    fields.push(payload.subarray(offset, offset + size).toString('utf8'))
    offset += size
  }
  if (offset !== payload.length) fail('standalone-task-lifecycle-response-invalid')
  let error
  let cancelReason
  let cleanupEvents
  let outputDigest
  let trace
  try {
    error = JSON.parse(fields[11])
    cancelReason = JSON.parse(fields[13])
    cleanupEvents = JSON.parse(fields[14])
    outputDigest = JSON.parse(fields[17])
    trace = JSON.parse(fields[21])
  } catch {
    fail('standalone-task-lifecycle-response-json-invalid')
  }
  return {
    attempts: decimal(fields[12]),
    cancel_reason: cancelReason,
    cleanup_events: cleanupEvents,
    effect_count: decimal(fields[15]),
    effects_digest: fields[16],
    error,
    observation_digest: fields[8],
    output_digest: outputDigest,
    package_digest: fields[0],
    performer_calls: decimal(fields[18]),
    reference_report_digest: fields[2],
    reference_request_digest: fields[9],
    replayed: fields[19] === 'true',
    request_digest: fields[7],
    scenario_digest: fields[5],
    scenario_id: fields[6],
    task_id: fields[20],
    terminal: fields[10],
    trace,
  }
}

function createReceipt({ oracle, parsed, response_wire }) {
  const result = {
    error: parsed.error,
    receipt: {
      attempts: parsed.attempts,
      cancel_reason: parsed.cancel_reason,
      cleanup_events: parsed.cleanup_events,
      effect_count: parsed.effect_count,
      effects_digest: parsed.effects_digest,
      output_digest: parsed.output_digest,
      performer_calls: parsed.performer_calls,
      replayed: parsed.replayed,
      schema: 're.task-runtime-lifecycle-receipt@0.1.0',
      task_id: parsed.task_id,
      trace: parsed.trace,
    },
    request_digest: parsed.reference_request_digest,
    schema: 're.task-runtime-lifecycle-result@0.1.0',
    terminal: parsed.terminal,
  }
  result.trace_digest = digestValue({
    cleanup_events: result.receipt.cleanup_events,
    trace: result.receipt.trace,
  })
  result.result_digest = lifecycleResultDigest(result)
  const receipt = {
    oracle_result_digest: oracle.result.result_digest,
    profile: STANDALONE_TASK_LIFECYCLE_PROFILE,
    request_digest: parsed.request_digest,
    response_wire_digest: digestBytes(response_wire),
    result,
    scenario_id: parsed.scenario_id,
    schema: STANDALONE_TASK_LIFECYCLE_RECEIPT_SCHEMA,
    status: 'closed',
  }
  receipt.receipt_digest = standaloneTaskLifecycleReceiptDigest(receipt)
  return receipt
}

function validateInputs(inputs) {
  validateAuthority(inputs)
  if (!isAbsolute(inputs.compiler_path)
    || typeof inputs.target_triple !== 'string'
    || !DIGEST.test(inputs.release_lock_digest)
    || !DIGEST.test(inputs.toolchain_digest)) {
    fail('standalone-task-lifecycle-input-invalid')
  }
}

function validateAuthority({ corpus, package_digest, reference } = {}) {
  validateReference(reference)
  if (!plainObject(corpus)
    || corpus.schema !== 're.task-runtime-lifecycle-corpus@0.1.0'
    || !Array.isArray(corpus.scenarios)
    || corpus.scenarios.length !== SCENARIO_KINDS.length
    || !DIGEST.test(package_digest)
    || digestValue(corpus) !== reference.corpus_digest) {
    fail('standalone-task-lifecycle-authority-invalid')
  }
  for (let index = 0; index < SCENARIO_KINDS.length; index += 1) {
    const scenario = corpus.scenarios[index]
    if (!plainObject(scenario)
      || scenario.id !== SCENARIO_KINDS[index]
      || scenario.kind !== SCENARIO_KINDS[index]
      || reference.workloads[index].id !== scenario.id) {
      fail('standalone-task-lifecycle-scenario-authority-invalid')
    }
  }
}

function validateReference(reference) {
  if (!plainObject(reference)
    || reference.schema !== 're.task-runtime-lifecycle-report@0.1.0'
    || !DIGEST.test(reference.report_digest)
    || !DIGEST.test(reference.corpus_digest)
    || !Array.isArray(reference.workloads)
    || reference.workloads.length !== SCENARIO_KINDS.length) {
    fail('standalone-task-lifecycle-reference-invalid')
  }
  for (let index = 0; index < reference.workloads.length; index += 1) {
    const workload = reference.workloads[index]
    if (!plainObject(workload)
      || workload.id !== SCENARIO_KINDS[index]
      || !plainObject(workload.request)
      || !plainObject(workload.result)
      || !plainObject(workload.result.receipt)
      || !DIGEST.test(workload.request.contract_digest)
      || !DIGEST.test(workload.request.scenario_digest)
      || !DIGEST.test(workload.request.task_request_digest)
      || !DIGEST.test(workload.request.request_digest)
      || !DIGEST.test(workload.result.result_digest)) {
      fail('standalone-task-lifecycle-reference-invalid')
    }
  }
}

function validateRequest(request) {
  if (!plainObject(request)
    || !exactShape(request, REQUEST_FIELDS)
    || request.schema !== STANDALONE_TASK_LIFECYCLE_REQUEST_SCHEMA
    || request.profile !== STANDALONE_TASK_LIFECYCLE_PROFILE
    || !plainObject(request.observation)
    || !exactShape(request.observation, ['kind'])
    || !DIGEST.test(request.contract_digest)
    || !DIGEST.test(request.corpus_digest)
    || !DIGEST.test(request.observation_digest)
    || !DIGEST.test(request.package_digest)
    || !DIGEST.test(request.reference_report_digest)
    || !DIGEST.test(request.reference_request_digest)
    || !DIGEST.test(request.request_digest)
    || !DIGEST.test(request.scenario_digest)
    || !DIGEST.test(request.task_request_digest)
    || request.observation_digest !== digestValue(request.observation)
    || request.request_digest !== standaloneTaskLifecycleRequestDigest(request)) {
    fail('standalone-task-lifecycle-request-invalid')
  }
}

function validateReport(report) {
  if (!plainObject(report)
    || !exactShape(report, REPORT_FIELDS)
    || report.schema !== STANDALONE_TASK_LIFECYCLE_REPORT_SCHEMA
    || report.profile !== STANDALONE_TASK_LIFECYCLE_PROFILE
    || report.wire_schema !== STANDALONE_TASK_LIFECYCLE_WIRE_SCHEMA
    || report.status !== 'measured'
    || !DIGEST.test(report.report_digest)
    || !Array.isArray(report.workloads)
    || report.workloads.length !== SCENARIO_KINDS.length) {
    fail('standalone-task-lifecycle-report-invalid')
  }
  for (let index = 0; index < report.workloads.length; index += 1) {
    const workload = report.workloads[index]
    if (!plainObject(workload)
      || !exactShape(workload, WORKLOAD_FIELDS)
      || workload.id !== SCENARIO_KINDS[index]
      || workload.executable_digest !== report.executable_digest
      || workload.workload_digest
        !== standaloneTaskLifecycleWorkloadDigest(workload)
      || !plainObject(workload.receipt)
      || !exactShape(workload.receipt, RECEIPT_FIELDS)
      || workload.receipt.receipt_digest
        !== standaloneTaskLifecycleReceiptDigest(workload.receipt)) {
      fail('standalone-task-lifecycle-workload-invalid')
    }
    validateRequest(workload.request)
  }
}

async function compilerProvenance({ compiler_path, target_triple }) {
  let bytes
  let metadata
  try {
    bytes = await readFile(compiler_path)
    metadata = await stat(compiler_path)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('standalone-task-lifecycle-compiler-missing')
    throw error
  }
  if (!metadata.isFile()) fail('standalone-task-lifecycle-compiler-invalid')
  const version = spawnSync(compiler_path, ['--version'], {
    encoding: 'utf8',
    shell: false,
  })
  if (version.error || version.status !== 0 || version.stdout.length === 0) {
    fail('standalone-task-lifecycle-compiler-version-failed')
  }
  return {
    architecture: arch(),
    compiler_digest: digestBytes(bytes),
    compiler_path,
    compiler_version_digest: digestBytes(Buffer.from(version.stdout, 'utf8')),
    operating_system: platform(),
    operating_system_release: release(),
    target_triple,
  }
}

function frame(magic, payload) {
  if (payload.length > MAX_PAYLOAD_BYTES) {
    fail('standalone-task-lifecycle-wire-payload-too-large')
  }
  const header = Buffer.alloc(HEADER_BYTES)
  magic.copy(header, 0)
  header.writeUInt32LE(payload.length, 8)
  sha256(payload).copy(header, 12)
  return Buffer.concat([header, payload])
}

function fieldBytes(value) {
  if (typeof value !== 'string') fail('standalone-task-lifecycle-wire-field-invalid')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > 4096) fail('standalone-task-lifecycle-wire-field-invalid')
  return Buffer.concat([u16(bytes.length), bytes])
}

function u16(value) {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16LE(value)
  return bytes
}

function decimal(value) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    fail('standalone-task-lifecycle-response-number-invalid')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    fail('standalone-task-lifecycle-response-number-invalid')
  }
  return parsed
}

function lifecycleResultDigest(result) {
  const { result_digest: ignored, ...content } = result
  return digestValue(content)
}

function cString(value) {
  return JSON.stringify(value)
    .replaceAll('\\u2028', '\\\\u2028')
    .replaceAll('\\u2029', '\\\\u2029')
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
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function exactShape(value, fields) {
  return plainObject(value)
    && canonicalEqual(Object.keys(value).sort(), [...fields].sort())
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(code) {
  throw Object.assign(new Error(code), { code })
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
