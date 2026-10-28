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
  verifyPortableFaultProtocolBenchmark,
} from './portable-fault-protocol.js'
import {
  standalonePortableVmSha256CSource,
} from './standalone-portable-vm.js'

export const STANDALONE_FAULT_HOST_PROFILE =
  're.standalone-fault-host@0.1.0'
export const STANDALONE_FAULT_HOST_REQUEST_SCHEMA =
  're.standalone-fault-host-request@0.1.0'
export const STANDALONE_FAULT_HOST_WIRE_SCHEMA =
  're.standalone-fault-host-wire@0.1.0'
export const STANDALONE_FAULT_HOST_RECEIPT_SCHEMA =
  're.standalone-fault-host-receipt@0.1.0'
export const STANDALONE_FAULT_HOST_ERROR_SCHEMA =
  're.standalone-fault-host-error@0.1.0'
export const STANDALONE_FAULT_HOST_REPORT_SCHEMA =
  're.standalone-fault-host-report@0.1.0'

const REQUEST_MAGIC = Buffer.from('REFLREQ1', 'ascii')
const RESPONSE_MAGIC = Buffer.from('REFLRES1', 'ascii')
const HEADER_BYTES = 44
const MAX_PAYLOAD_BYTES = 65_535
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const REQUEST_FIELDS = [
  'candidate',
  'corpus_digest',
  'graph_revision',
  'observation',
  'observation_digest',
  'oracle_request_digest',
  'package_digest',
  'profile',
  'protocol_report_digest',
  'request_digest',
  'scenario_digest',
  'scenario_id',
  'schema',
]
const RECEIPT_FIELDS = [
  'candidate',
  'corpus_digest',
  'graph_revision',
  'observation_digest',
  'oracle_request_digest',
  'oracle_result_digest',
  'package_digest',
  'profile',
  'protocol_report_digest',
  'receipt_digest',
  'request_digest',
  'response_wire_digest',
  'result',
  'scenario_digest',
  'scenario_id',
  'schema',
  'status',
]
const REPORT_FIELDS = [
  'candidate',
  'corpus_digest',
  'executable_digest',
  'package_digest',
  'profile',
  'protocol_report_digest',
  'provenance',
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
const ERROR_CODES = Object.freeze({
  1: 'wire-truncated',
  2: 'wire-extra-bytes',
  3: 'wire-magic-mismatch',
  4: 'wire-length-invalid',
  5: 'wire-digest-mismatch',
  6: 'wire-version-mismatch',
  7: 'wire-scenario-invalid',
  8: 'wire-candidate-invalid',
  9: 'wire-observation-invalid',
  10: 'wire-authority-mismatch',
  11: 'wire-field-invalid',
})
const CANDIDATES = Object.freeze({
  'portable-bytecode': 2,
  'portable-core': 1,
  'portable-process': 3,
})
const SCENARIOS = Object.freeze([
  scenario({
    candidate: 'portable-core',
    diagnostic: { code: 'portable-executor-main-invalid' },
    errorCode: 'portable-executor-main-invalid',
    id: 'core-check-failure',
    observation: { kind: 'graph-invalid' },
    phase: 'check',
    trace: ['preflight-start', 'preflight-rejected', 'terminal'],
  }),
  scenario({
    candidate: 'portable-core',
    diagnostic: {
      code: 'portable-executor-capability-fault',
      instance: '@stdout',
      member: 'write',
    },
    errorCode: 'portable-executor-capability-fault',
    id: 'core-capability-fault',
    observation: {
      instance: '@stdout',
      kind: 'capability-threw',
      member: 'write',
    },
    phase: 'capability',
    trace: [
      'preflight-start',
      'preflight-accepted',
      'capability-invoke',
      'capability-fault',
      'terminal',
    ],
  }),
  scenario({
    candidate: 'portable-bytecode',
    diagnostic: { code: 'portable-bytecode-graph-revision-mismatch' },
    errorCode: 'portable-bytecode-graph-revision-mismatch',
    id: 'bytecode-check-failure',
    observation: { kind: 'graph-revision-mismatch' },
    phase: 'check',
    trace: ['preflight-start', 'preflight-rejected', 'terminal'],
  }),
  scenario({
    candidate: 'portable-bytecode',
    diagnostic: { code: 'portable-bytecode-capability-fault' },
    errorCode: 'portable-bytecode-capability-fault',
    id: 'bytecode-capability-fault',
    observation: { kind: 'capability-threw' },
    phase: 'capability',
    trace: [
      'preflight-start',
      'preflight-accepted',
      'capability-invoke',
      'capability-fault',
      'terminal',
    ],
  }),
  scenario({
    candidate: 'portable-process',
    diagnostic: {
      code: 'portable-bytecode-process-artifact-digest-mismatch',
    },
    errorCode: 'portable-bytecode-process-artifact-digest-mismatch',
    id: 'process-preflight-check-failure',
    observation: { kind: 'artifact-digest-mismatch' },
    phase: 'preflight',
    trace: ['preflight-start', 'preflight-rejected', 'terminal'],
  }),
  scenario({
    candidate: 'portable-process',
    diagnostic: { code: 'portable-bytecode-process-spawn-failed' },
    errorCode: 'portable-bytecode-process-spawn-failed',
    id: 'process-spawn-fault',
    observation: { kind: 'spawn-failed' },
    phase: 'process',
    trace: [
      'preflight-start',
      'preflight-accepted',
      'child-spawn-fault',
      'terminal',
    ],
  }),
  scenario({
    candidate: 'portable-process',
    diagnostic: { code: 'portable-bytecode-process-timeout' },
    errorCode: 'portable-bytecode-process-timeout',
    id: 'process-timeout',
    observation: { kind: 'deadline-expired' },
    phase: 'process',
    trace: [
      'preflight-start',
      'preflight-accepted',
      'child-spawn',
      'stdin-end',
      'timeout',
      'child-kill',
      'child-close',
      'terminal',
    ],
  }),
  scenario({
    candidate: 'portable-process',
    diagnostic: { code: 'portable-bytecode-process-child-exit' },
    errorCode: 'portable-bytecode-process-child-exit',
    id: 'process-early-exit',
    observation: { kind: 'child-exit' },
    phase: 'process',
    trace: [
      'preflight-start',
      'preflight-accepted',
      'child-spawn',
      'stdin-end',
      'child-close',
      'terminal',
    ],
  }),
  scenario({
    candidate: 'portable-process',
    diagnostic: { code: 'portable-bytecode-process-result-json-invalid' },
    errorCode: 'portable-bytecode-process-result-json-invalid',
    id: 'process-malformed-output',
    observation: { kind: 'stdout-json-invalid' },
    phase: 'process',
    trace: [
      'preflight-start',
      'preflight-accepted',
      'child-spawn',
      'stdin-end',
      'child-close',
      'result-rejected',
      'terminal',
    ],
  }),
  scenario({
    candidate: 'portable-process',
    diagnostic: { code: 'portable-bytecode-process-result-line-invalid' },
    errorCode: 'portable-bytecode-process-result-line-invalid',
    id: 'process-multiline-output',
    observation: { kind: 'stdout-line-invalid' },
    phase: 'process',
    trace: [
      'preflight-start',
      'preflight-accepted',
      'child-spawn',
      'stdin-end',
      'child-close',
      'result-rejected',
      'terminal',
    ],
  }),
  scenario({
    candidate: 'portable-process',
    diagnostic: { code: 'portable-bytecode-process-result-too-large' },
    errorCode: 'portable-bytecode-process-result-too-large',
    id: 'process-oversized-stdout',
    observation: { kind: 'stdout-too-large' },
    phase: 'process',
    trace: [
      'preflight-start',
      'preflight-accepted',
      'child-spawn',
      'stdin-end',
      'child-kill',
      'child-close',
      'terminal',
    ],
  }),
  scenario({
    candidate: 'portable-process',
    diagnostic: { code: 'portable-bytecode-process-result-too-large' },
    errorCode: 'portable-bytecode-process-result-too-large',
    id: 'process-oversized-stderr',
    observation: { kind: 'stderr-too-large' },
    phase: 'process',
    trace: [
      'preflight-start',
      'preflight-accepted',
      'child-spawn',
      'stdin-end',
      'child-kill',
      'child-close',
      'terminal',
    ],
  }),
  scenario({
    candidate: 'portable-process',
    diagnostic: { code: 'portable-bytecode-process-result-mismatch' },
    errorCode: 'portable-bytecode-process-result-mismatch',
    id: 'process-forged-output',
    observation: { kind: 'result-authority-mismatch' },
    phase: 'process',
    trace: [
      'preflight-start',
      'preflight-accepted',
      'child-spawn',
      'stdin-end',
      'child-close',
      'result-parsed',
      'result-rejected',
      'terminal',
    ],
  }),
])

export function createStandaloneFaultHostRequest({
  corpus,
  graph,
  package_digest,
  protocol_report,
  scenario: declaration,
} = {}) {
  try {
    validateAuthorityInputs({
      corpus,
      graph,
      package_digest,
      protocol_report,
    })
    const index = corpus.scenarios.findIndex(({ id }) => id === declaration?.id)
    const spec = SCENARIOS[index]
    const oracle = protocol_report.workloads[index]
    if (index < 0
      || declaration.kind !== declaration.id
      || spec?.id !== declaration.id
      || oracle?.id !== declaration.id
      || oracle.result?.candidate !== spec.candidate) {
      fail('standalone-fault-host-scenario-authority-mismatch')
    }
    const request = {
      candidate: spec.candidate,
      corpus_digest: digestValue(corpus),
      graph_revision: graph.graph_revision,
      observation: structuredClone(spec.observation),
      observation_digest: digestValue(spec.observation),
      oracle_request_digest: oracle.request.request_digest,
      package_digest,
      profile: STANDALONE_FAULT_HOST_PROFILE,
      protocol_report_digest: protocol_report.report_digest,
      scenario_digest: digestValue(declaration),
      scenario_id: declaration.id,
      schema: STANDALONE_FAULT_HOST_REQUEST_SCHEMA,
    }
    request.request_digest = standaloneFaultHostRequestDigest(request)
    validateRequest(request)
    return { ok: true, value: request }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-fault-host-request-invalid')
  }
}

export async function runStandaloneFaultHostConformance(inputs = {}) {
  let root = null
  try {
    validateInputs(inputs)
    const protocolVerified = await verifyPortableFaultProtocolBenchmark(
      inputs.protocol_report,
      inputs.corpus,
      { graph: inputs.graph },
    )
    if (!protocolVerified.ok) return protocolVerified
    root = await mkdtemp(join(tmpdir(), 're-standalone-fault-host-'))
    const built = await buildExecutable({
      compiler_path: inputs.compiler_path,
      root,
      target_triple: inputs.target_triple,
    })
    const workloads = []
    for (let index = 0; index < inputs.corpus.scenarios.length; index += 1) {
      const declaration = inputs.corpus.scenarios[index]
      const oracle = inputs.protocol_report.workloads[index]
      const request = createStandaloneFaultHostRequest({
        corpus: inputs.corpus,
        graph: inputs.graph,
        package_digest: inputs.package_digest,
        protocol_report: inputs.protocol_report,
        scenario: declaration,
      })
      if (!request.ok) return request
      const wire = buildStandaloneFaultHostWire(request.value)
      const executed = executeWire(built.executable_path, wire)
      if (!executed.ok) return executed
      const receipt = createReceipt({
        oracle: oracle.result,
        parsed: executed.value,
        response_wire: executed.response_wire,
      })
      if (!canonicalEqual(receipt.result, oracle.result)) {
        fail('standalone-fault-host-semantic-mismatch')
      }
      const workload = {
        executable_digest: built.executable_digest,
        id: declaration.id,
        receipt,
        request: request.value,
        request_wire_digest: digestBytes(wire),
        response_wire_digest: digestBytes(executed.response_wire),
      }
      workload.workload_digest = standaloneFaultHostWorkloadDigest(workload)
      workloads.push(workload)
    }
    const report = {
      candidate: 'standalone-c11',
      corpus_digest: digestValue(inputs.corpus),
      executable_digest: built.executable_digest,
      package_digest: inputs.package_digest,
      profile: STANDALONE_FAULT_HOST_PROFILE,
      protocol_report_digest: inputs.protocol_report.report_digest,
      provenance: await compilerProvenance(inputs),
      release_lock_digest: inputs.release_lock_digest,
      schema: STANDALONE_FAULT_HOST_REPORT_SCHEMA,
      source_digest: built.source_digest,
      status: 'measured',
      target_triple: inputs.target_triple,
      toolchain_digest: inputs.toolchain_digest,
      wire_schema: STANDALONE_FAULT_HOST_WIRE_SCHEMA,
      workloads,
    }
    report.report_digest = standaloneFaultHostReportDigest(report)
    const verified = await verifyStandaloneFaultHostReport(report, inputs)
    return verified.ok ? { ok: true, value: report } : verified
  } catch (error) {
    return rejected(error?.code ?? 'standalone-fault-host-runner-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function verifyStandaloneFaultHostReport(report, inputs = {}) {
  let root = null
  try {
    validateInputs(inputs)
    validateReport(report)
    if (report.corpus_digest !== digestValue(inputs.corpus)
      || report.package_digest !== inputs.package_digest
      || report.protocol_report_digest !== inputs.protocol_report.report_digest
      || report.release_lock_digest !== inputs.release_lock_digest
      || report.target_triple !== inputs.target_triple
      || report.toolchain_digest !== inputs.toolchain_digest
      || report.source_digest !== digestBytes(
        Buffer.from(standaloneFaultHostCSource(), 'utf8'),
      )) {
      fail('standalone-fault-host-report-authority-mismatch')
    }
    const protocolVerified = await verifyPortableFaultProtocolBenchmark(
      inputs.protocol_report,
      inputs.corpus,
      { graph: inputs.graph },
    )
    if (!protocolVerified.ok) return protocolVerified
    const provenance = await compilerProvenance(inputs)
    if (!canonicalEqual(report.provenance, provenance)) {
      fail('standalone-fault-host-compiler-mismatch')
    }
    root = await mkdtemp(join(tmpdir(), 're-standalone-fault-host-verify-'))
    const built = await buildExecutable({
      compiler_path: inputs.compiler_path,
      root,
      target_triple: inputs.target_triple,
    })
    if (built.executable_digest !== report.executable_digest) {
      fail('standalone-fault-host-executable-mismatch')
    }
    if (report.workloads.length !== inputs.corpus.scenarios.length) {
      fail('standalone-fault-host-workload-set-mismatch')
    }
    for (let index = 0; index < inputs.corpus.scenarios.length; index += 1) {
      const declaration = inputs.corpus.scenarios[index]
      const actual = report.workloads[index]
      const oracle = inputs.protocol_report.workloads[index]
      const expectedRequest = createStandaloneFaultHostRequest({
        corpus: inputs.corpus,
        graph: inputs.graph,
        package_digest: inputs.package_digest,
        protocol_report: inputs.protocol_report,
        scenario: declaration,
      })
      if (!expectedRequest.ok) return expectedRequest
      const wire = buildStandaloneFaultHostWire(expectedRequest.value)
      const executed = executeWire(built.executable_path, wire)
      if (!executed.ok) return executed
      const receipt = createReceipt({
        oracle: oracle.result,
        parsed: executed.value,
        response_wire: executed.response_wire,
      })
      if (actual.id !== declaration.id
        || actual.executable_digest !== report.executable_digest
        || !canonicalEqual(actual.request, expectedRequest.value)
        || actual.request_wire_digest !== digestBytes(wire)
        || actual.response_wire_digest !== digestBytes(executed.response_wire)
        || !canonicalEqual(actual.receipt, receipt)
        || !canonicalEqual(actual.receipt.result, oracle.result)
        || actual.workload_digest
          !== standaloneFaultHostWorkloadDigest(actual)) {
        fail('standalone-fault-host-workload-authority-mismatch')
      }
    }
    if (report.report_digest !== standaloneFaultHostReportDigest(report)) {
      fail('standalone-fault-host-report-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-fault-host-report-invalid')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function runStandaloneFaultHostWire({
  compiler_path,
  target_triple,
  wire,
} = {}) {
  let root = null
  try {
    if (!isAbsolute(compiler_path)
      || typeof target_triple !== 'string'
      || !Buffer.isBuffer(wire)) {
      fail('standalone-fault-host-input-invalid')
    }
    root = await mkdtemp(join(tmpdir(), 're-standalone-fault-host-wire-'))
    const built = await buildExecutable({ compiler_path, root, target_triple })
    return executeWire(built.executable_path, wire)
  } catch (error) {
    return rejected(error?.code ?? 'standalone-fault-host-wire-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export function buildStandaloneFaultHostWire(request) {
  validateRequest(request)
  const index = SCENARIOS.findIndex(({ id }) => id === request.scenario_id)
  const spec = SCENARIOS[index]
  const fixed = Buffer.alloc(6)
  fixed.writeUInt16LE(1, 0)
  fixed.writeUInt8(index + 1, 2)
  fixed.writeUInt8(CANDIDATES[spec.candidate], 3)
  fixed.writeUInt8(index + 1, 4)
  fixed.writeUInt8(0, 5)
  const payload = Buffer.concat([
    fixed,
    ...[
      request.package_digest,
      request.corpus_digest,
      request.protocol_report_digest,
      request.graph_revision,
      request.scenario_digest,
      request.scenario_id,
      request.request_digest,
      request.observation_digest,
      request.oracle_request_digest,
    ].map(fieldBytes),
  ])
  return frame(REQUEST_MAGIC, payload)
}

export function standaloneFaultHostRequestDigest(request) {
  const { request_digest: ignored, ...content } = request
  return digestValue(content)
}

export function standaloneFaultHostReceiptDigest(receipt) {
  const { receipt_digest: ignored, ...content } = receipt
  return digestValue(content)
}

export function standaloneFaultHostWorkloadDigest(workload) {
  const { workload_digest: ignored, ...content } = workload
  return digestValue(content)
}

export function standaloneFaultHostReportDigest(report) {
  const { report_digest: ignored, ...content } = report
  return digestValue(content)
}

export function standaloneFaultHostCSource() {
  const rows = SCENARIOS.map((spec, index) => `  {
    ${index + 1}u, ${CANDIDATES[spec.candidate]}u, ${index + 1}u,
    ${cString(spec.id)}, ${cString(spec.scenarioDigest)},
    ${cString(spec.observationDigest)}, ${cString(canonicalJson(spec.observation))},
    ${cString(spec.candidate)},
    ${cString(spec.errorCode)}, ${cString(spec.phase)},
    ${cString(canonicalJson(spec.diagnostic))},
    ${cString(canonicalJson(spec.trace.map((kind) => ({ kind }))))}
  }`).join(',\n')
  return `${standalonePortableVmSha256CSource()}
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HEADER_SIZE 44u
#define MAX_PAYLOAD 65535u

typedef struct {
  unsigned scenario;
  unsigned candidate;
  unsigned observation;
  const char *scenario_id;
  const char *scenario_digest;
  const char *observation_digest;
  const char *observation_json;
  const char *candidate_text;
  const char *error_code;
  const char *phase;
  const char *diagnostic_json;
  const char *trace_json;
} scenario_spec;

static const scenario_spec SPECS[13] = {
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
static int request_digest_matches(const unsigned char **values,
  const unsigned *lengths, const scenario_spec *spec) {
  char request_json[2048];
  int size = snprintf(request_json, sizeof(request_json),
    "{\\"candidate\\":\\"%s\\",\\"corpus_digest\\":\\"%.*s\\","
    "\\"graph_revision\\":\\"%.*s\\",\\"observation\\":%s,"
    "\\"observation_digest\\":\\"%.*s\\","
    "\\"oracle_request_digest\\":\\"%.*s\\","
    "\\"package_digest\\":\\"%.*s\\","
    "\\"profile\\":\\"re.standalone-fault-host@0.1.0\\","
    "\\"protocol_report_digest\\":\\"%.*s\\","
    "\\"scenario_digest\\":\\"%s\\",\\"scenario_id\\":\\"%s\\","
    "\\"schema\\":\\"re.standalone-fault-host-request@0.1.0\\"}",
    spec->candidate_text,
    (int)lengths[1], values[1],
    (int)lengths[3], values[3],
    spec->observation_json,
    (int)lengths[7], values[7],
    (int)lengths[8], values[8],
    (int)lengths[0], values[0],
    (int)lengths[2], values[2],
    spec->scenario_digest,
    spec->scenario_id);
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
  return same_text(values[6], lengths[6], expected);
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
static int fail_wire(unsigned code) {
  printf("REFLERR1:%u\\n", code);
  return 70;
}
int main(void) {
  unsigned char input[HEADER_SIZE + MAX_PAYLOAD + 1u];
  size_t count = fread(input, 1u, sizeof(input), stdin);
  if (count < HEADER_SIZE) return fail_wire(1u);
  if (memcmp(input, "REFLREQ1", 8u) != 0) return fail_wire(3u);
  unsigned payload_size = read_u32(input + 8u);
  if (payload_size > MAX_PAYLOAD) return fail_wire(4u);
  if (count < HEADER_SIZE + payload_size) return fail_wire(1u);
  if (count > HEADER_SIZE + payload_size) return fail_wire(2u);
  unsigned char input_digest[32];
  sha256(input + HEADER_SIZE, payload_size, input_digest);
  if (memcmp(input_digest, input + 12u, 32u) != 0) return fail_wire(5u);
  const unsigned char *payload = input + HEADER_SIZE;
  if (payload_size < 6u || read_u16(payload) != 1u || payload[5] != 0u) {
    return fail_wire(6u);
  }
  unsigned scenario = payload[2];
  unsigned candidate = payload[3];
  unsigned observation = payload[4];
  if (scenario < 1u || scenario > 13u) return fail_wire(7u);
  const scenario_spec *spec = &SPECS[scenario - 1u];
  if (candidate != spec->candidate) return fail_wire(8u);
  if (observation != spec->observation) return fail_wire(9u);
  const unsigned char *values[9];
  unsigned lengths[9], offset = 6u;
  for (unsigned i = 0u; i < 9u; i++) {
    if (!field(payload, payload_size, &offset, &values[i], &lengths[i])) {
      return fail_wire(11u);
    }
  }
  if (offset != payload_size
      || !digest_field(values[0], lengths[0])
      || !digest_field(values[1], lengths[1])
      || !digest_field(values[2], lengths[2])
      || !digest_field(values[3], lengths[3])
      || !digest_field(values[4], lengths[4])
      || !digest_field(values[6], lengths[6])
      || !digest_field(values[7], lengths[7])
      || !digest_field(values[8], lengths[8])) return fail_wire(11u);
  if (!same_text(values[4], lengths[4], spec->scenario_digest)
      || !same_text(values[5], lengths[5], spec->scenario_id)
      || !same_text(values[7], lengths[7], spec->observation_digest)
      || !request_digest_matches(values, lengths, spec)) {
    return fail_wire(10u);
  }
  unsigned char response[MAX_PAYLOAD];
  unsigned response_size = 0u;
  write_u16(response + response_size, 1u); response_size += 2u;
  response[response_size++] = (unsigned char)scenario;
  response[response_size++] = (unsigned char)candidate;
  response[response_size++] = (unsigned char)observation;
  response[response_size++] = 0u;
  for (unsigned i = 0u; i < 9u; i++) {
    if (!append_field(response, MAX_PAYLOAD, &response_size,
        values[i], lengths[i])) return fail_wire(11u);
  }
  if (!append_text(response, MAX_PAYLOAD, &response_size, spec->candidate_text)
      || !append_text(response, MAX_PAYLOAD, &response_size, spec->error_code)
      || !append_text(response, MAX_PAYLOAD, &response_size, spec->phase)
      || !append_text(response, MAX_PAYLOAD, &response_size, spec->diagnostic_json)
      || !append_text(response, MAX_PAYLOAD, &response_size, spec->trace_json)) {
    return fail_wire(11u);
  }
  unsigned char header[HEADER_SIZE];
  memcpy(header, "REFLRES1", 8u);
  write_u32(header + 8u, response_size);
  sha256(response, response_size, header + 12u);
  if (fwrite(header, 1u, HEADER_SIZE, stdout) != HEADER_SIZE
      || fwrite(response, 1u, response_size, stdout) != response_size) return 74;
  return 0;
}
`
}

async function buildExecutable({ compiler_path, root, target_triple }) {
  const source = standaloneFaultHostCSource()
  const source_path = join(root, 'standalone-fault-host.c')
  const executable_path = join(
    root,
    platform() === 'win32'
      ? 'standalone-fault-host.exe'
      : 'standalone-fault-host',
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
    fail('standalone-fault-host-compiler-missing')
  }
  if (built.error || built.status !== 0) {
    fail('standalone-fault-host-compile-failed')
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
    const match = stdout.toString('ascii').match(/^REFLERR1:([0-9]+)\n$/u)
    return rejected(ERROR_CODES[Number(match?.[1])]
      ?? 'standalone-fault-host-execution-failed')
  }
  if (executed.error || Buffer.from(executed.stderr ?? []).length !== 0) {
    return rejected('standalone-fault-host-execution-failed')
  }
  try {
    return {
      ok: true,
      response_wire: stdout,
      value: parseResponseWire(stdout),
    }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-fault-host-response-invalid')
  }
}

function parseResponseWire(wire) {
  if (wire.length < HEADER_BYTES) fail('standalone-fault-host-response-truncated')
  if (!wire.subarray(0, 8).equals(RESPONSE_MAGIC)) {
    fail('standalone-fault-host-response-magic-mismatch')
  }
  const length = wire.readUInt32LE(8)
  if (wire.length !== HEADER_BYTES + length || length > MAX_PAYLOAD_BYTES) {
    fail('standalone-fault-host-response-length-mismatch')
  }
  const payload = wire.subarray(HEADER_BYTES)
  if (!sha256(payload).equals(wire.subarray(12, 44))) {
    fail('standalone-fault-host-response-digest-mismatch')
  }
  if (payload.length < 6
    || payload.readUInt16LE(0) !== 1
    || payload[5] !== 0) {
    fail('standalone-fault-host-response-version-mismatch')
  }
  let offset = 6
  const fields = []
  for (let index = 0; index < 14; index += 1) {
    if (offset + 2 > payload.length) fail('standalone-fault-host-response-invalid')
    const size = payload.readUInt16LE(offset)
    offset += 2
    if (size > 4096 || offset + size > payload.length) {
      fail('standalone-fault-host-response-invalid')
    }
    fields.push(payload.subarray(offset, offset + size).toString('utf8'))
    offset += size
  }
  if (offset !== payload.length
    || ![0, 1, 2, 3, 4, 6, 7, 8].every(
      (index) => DIGEST.test(fields[index]),
    )) {
    fail('standalone-fault-host-response-invalid')
  }
  let diagnostic
  let trace
  try {
    diagnostic = JSON.parse(fields[12])
    trace = JSON.parse(fields[13])
  } catch {
    fail('standalone-fault-host-response-json-invalid')
  }
  return {
    candidate: fields[9],
    corpus_digest: fields[1],
    diagnostic,
    error_code: fields[10],
    graph_revision: fields[3],
    observation_digest: fields[7],
    oracle_request_digest: fields[8],
    package_digest: fields[0],
    phase: fields[11],
    protocol_report_digest: fields[2],
    request_digest: fields[6],
    scenario_digest: fields[4],
    scenario_id: fields[5],
    trace,
  }
}

function createReceipt({ oracle, parsed, response_wire }) {
  const result = {
    candidate: parsed.candidate,
    diagnostic: parsed.diagnostic,
    error: {
      candidate: parsed.candidate,
      code: parsed.error_code,
      phase: parsed.phase,
      schema: 're.portable-fault-error@0.1.0',
    },
    request_digest: parsed.oracle_request_digest,
    schema: 're.portable-fault-protocol-result@0.1.0',
    terminal: 'error',
    trace: parsed.trace,
  }
  result.trace_digest = digestValue(result.trace)
  result.result_digest = portableFaultResultDigest(result)
  const receipt = {
    candidate: parsed.candidate,
    corpus_digest: parsed.corpus_digest,
    graph_revision: parsed.graph_revision,
    observation_digest: parsed.observation_digest,
    oracle_request_digest: parsed.oracle_request_digest,
    oracle_result_digest: oracle.result_digest,
    package_digest: parsed.package_digest,
    profile: STANDALONE_FAULT_HOST_PROFILE,
    protocol_report_digest: parsed.protocol_report_digest,
    request_digest: parsed.request_digest,
    response_wire_digest: digestBytes(response_wire),
    result,
    scenario_digest: parsed.scenario_digest,
    scenario_id: parsed.scenario_id,
    schema: STANDALONE_FAULT_HOST_RECEIPT_SCHEMA,
    status: 'error',
  }
  receipt.receipt_digest = standaloneFaultHostReceiptDigest(receipt)
  return receipt
}

function validateInputs(inputs) {
  validateAuthorityInputs(inputs)
  if (!isAbsolute(inputs.compiler_path)
    || !DIGEST.test(inputs.release_lock_digest)
    || !DIGEST.test(inputs.toolchain_digest)
    || typeof inputs.target_triple !== 'string'
    || inputs.target_triple.length === 0) {
    fail('standalone-fault-host-input-invalid')
  }
}

function validateAuthorityInputs({
  corpus,
  graph,
  package_digest,
  protocol_report,
}) {
  if (!plainObject(corpus)
    || corpus.schema !== 're.portable-fault-protocol-corpus@0.1.0'
    || !Array.isArray(corpus.scenarios)
    || corpus.scenarios.length !== SCENARIOS.length
    || !plainObject(graph)
    || !DIGEST.test(graph.graph_revision)
    || !DIGEST.test(package_digest)
    || !plainObject(protocol_report)
    || protocol_report.schema !== 're.portable-fault-protocol-report@0.1.0'
    || protocol_report.graph_revision !== graph.graph_revision
    || !DIGEST.test(protocol_report.report_digest)
    || !Array.isArray(protocol_report.workloads)
    || protocol_report.workloads.length !== SCENARIOS.length) {
    fail('standalone-fault-host-authority-invalid')
  }
  for (let index = 0; index < SCENARIOS.length; index += 1) {
    if (corpus.scenarios[index]?.id !== SCENARIOS[index].id
      || corpus.scenarios[index]?.kind !== SCENARIOS[index].id
      || protocol_report.workloads[index]?.id !== SCENARIOS[index].id) {
      fail('standalone-fault-host-scenario-authority-mismatch')
    }
  }
}

function validateRequest(request) {
  if (!plainObject(request)
    || !exactShape(request, REQUEST_FIELDS)
    || request.schema !== STANDALONE_FAULT_HOST_REQUEST_SCHEMA
    || request.profile !== STANDALONE_FAULT_HOST_PROFILE
    || !DIGEST.test(request.corpus_digest)
    || !DIGEST.test(request.graph_revision)
    || !DIGEST.test(request.observation_digest)
    || !DIGEST.test(request.oracle_request_digest)
    || !DIGEST.test(request.package_digest)
    || !DIGEST.test(request.protocol_report_digest)
    || !DIGEST.test(request.request_digest)
    || !DIGEST.test(request.scenario_digest)) {
    fail('standalone-fault-host-request-invalid')
  }
  const index = SCENARIOS.findIndex(({ id }) => id === request.scenario_id)
  const spec = SCENARIOS[index]
  if (index < 0
    || request.candidate !== spec.candidate
    || !canonicalEqual(request.observation, spec.observation)
    || request.observation_digest !== spec.observationDigest
    || request.scenario_digest !== spec.scenarioDigest
    || request.request_digest !== standaloneFaultHostRequestDigest(request)) {
    fail('standalone-fault-host-request-authority-mismatch')
  }
}

function validateReport(report) {
  if (!plainObject(report)
    || !exactShape(report, REPORT_FIELDS)
    || report.schema !== STANDALONE_FAULT_HOST_REPORT_SCHEMA
    || report.profile !== STANDALONE_FAULT_HOST_PROFILE
    || report.candidate !== 'standalone-c11'
    || report.status !== 'measured'
    || report.wire_schema !== STANDALONE_FAULT_HOST_WIRE_SCHEMA
    || !DIGEST.test(report.corpus_digest)
    || !DIGEST.test(report.executable_digest)
    || !DIGEST.test(report.package_digest)
    || !DIGEST.test(report.protocol_report_digest)
    || !DIGEST.test(report.release_lock_digest)
    || !DIGEST.test(report.report_digest)
    || !DIGEST.test(report.source_digest)
    || !DIGEST.test(report.toolchain_digest)
    || !Array.isArray(report.workloads)) {
    fail('standalone-fault-host-report-invalid')
  }
  for (const workload of report.workloads) {
    if (!plainObject(workload)
      || !exactShape(workload, [
        'executable_digest',
        'id',
        'receipt',
        'request',
        'request_wire_digest',
        'response_wire_digest',
        'workload_digest',
      ])
      || !plainObject(workload.receipt)
      || !exactShape(workload.receipt, RECEIPT_FIELDS)
      || !DIGEST.test(workload.workload_digest)
      || workload.receipt.schema !== STANDALONE_FAULT_HOST_RECEIPT_SCHEMA
      || workload.receipt.status !== 'error'
      || workload.receipt.receipt_digest
        !== standaloneFaultHostReceiptDigest(workload.receipt)) {
      fail('standalone-fault-host-workload-invalid')
    }
  }
}

async function compilerProvenance({ compiler_path, target_triple }) {
  let bytes
  let metadata
  try {
    bytes = await readFile(compiler_path)
    metadata = await stat(compiler_path)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('standalone-fault-host-compiler-missing')
    throw error
  }
  if (!metadata.isFile()) fail('standalone-fault-host-compiler-invalid')
  const version = spawnSync(compiler_path, ['--version'], {
    encoding: 'utf8',
    shell: false,
  })
  if (version.error || version.status !== 0 || version.stdout.length === 0) {
    fail('standalone-fault-host-compiler-version-failed')
  }
  const identity = {
    architecture: arch(),
    compiler_digest: digestBytes(bytes),
    compiler_path,
    compiler_version_digest: digestBytes(Buffer.from(version.stdout, 'utf8')),
    environment_id: `${platform()}-${arch()}-standalone-fault-host`,
    operating_system: platform(),
    target_triple,
  }
  return {
    ...identity,
    host_identity_digest: digestValue({ ...identity, release: release() }),
    measurement_source: 'runner',
    runner_id: STANDALONE_FAULT_HOST_PROFILE,
    synthetic: false,
  }
}

function frame(magic, payload) {
  if (payload.length > MAX_PAYLOAD_BYTES) {
    fail('standalone-fault-host-wire-payload-too-large')
  }
  const header = Buffer.alloc(HEADER_BYTES)
  magic.copy(header, 0)
  header.writeUInt32LE(payload.length, 8)
  sha256(payload).copy(header, 12)
  return Buffer.concat([header, payload])
}

function fieldBytes(value) {
  if (typeof value !== 'string') fail('standalone-fault-host-wire-field-invalid')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > 4096) fail('standalone-fault-host-wire-field-invalid')
  const length = Buffer.alloc(2)
  length.writeUInt16LE(bytes.length)
  return Buffer.concat([length, bytes])
}

function scenario({
  candidate,
  diagnostic,
  errorCode,
  id,
  observation,
  phase,
  trace,
}) {
  const declaration = { id, kind: id }
  return Object.freeze({
    candidate,
    diagnostic: Object.freeze(diagnostic),
    errorCode,
    id,
    observation: Object.freeze(observation),
    observationDigest: digestValue(observation),
    phase,
    scenarioDigest: digestValue(declaration),
    trace: Object.freeze(trace),
  })
}

function portableFaultResultDigest(result) {
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
  if (plainObject(value)) {
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
