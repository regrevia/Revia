import { spawn, spawnSync } from 'node:child_process'
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

import { minimalStdPackageManifest } from './minimal-std-abi.js'
import {
  verifyMinimalStdNativeBundle,
} from './minimal-std-native.js'
import {
  executeMinimalStdOperation,
} from './minimal-std-subset.js'
import {
  standalonePortableVmSha256CSource,
} from './standalone-portable-vm.js'

export const STANDALONE_MINIMAL_STD_PROFILE =
  're.standalone-minimal-std@0.1.0'
export const STANDALONE_MINIMAL_STD_REQUEST_SCHEMA =
  're.standalone-minimal-std-request@0.1.0'
export const STANDALONE_MINIMAL_STD_WIRE_SCHEMA =
  're.standalone-minimal-std-wire@0.2.0'
export const STANDALONE_MINIMAL_STD_RECEIPT_SCHEMA =
  're.standalone-minimal-std-receipt@0.1.0'
export const STANDALONE_MINIMAL_STD_ERROR_SCHEMA =
  're.standalone-minimal-std-error@0.1.0'
export const STANDALONE_MINIMAL_STD_REPORT_SCHEMA =
  're.standalone-minimal-std-report@0.1.0'

const REQUEST_MAGIC = Buffer.from('RESTREQ1', 'ascii')
const RESPONSE_MAGIC = Buffer.from('RESTRES1', 'ascii')
const HEADER_BYTES = 44
const MAX_PAYLOAD_BYTES = 65_535
const DEFAULT_EXECUTION_TIMEOUT_MS = 5_000
const MAX_EXECUTION_TIMEOUT_MS = 60_000
const MAX_EXECUTION_OUTPUT_BYTES = 1024 * 1024
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const OPERATION_CODES = new Map([
  ['std.bytes.byte_count', 1],
  ['std.bytes.concat', 2],
  ['std.bytes.decode_utf8', 3],
  ['std.list.append', 4],
  ['std.list.concat', 5],
  ['std.list.length', 6],
  ['std.result.is_err', 7],
  ['std.result.is_ok', 8],
  ['std.text.concat', 9],
  ['std.text.encode_utf8', 10],
  ['std.text.scalar_count', 11],
])
const TYPE_ARGUMENTS = new Map([
  [1, []],
  [2, []],
  [3, []],
  [4, ['text.utf8']],
  [5, ['text.utf8']],
  [6, ['text.utf8']],
  [7, ['text.utf8', 'std.bytes.decode_error']],
  [8, ['text.utf8', 'std.bytes.decode_error']],
  [9, []],
  [10, []],
  [11, []],
])
const ERROR_CODES = Object.freeze({
  1: 'wire-truncated',
  2: 'wire-extra-bytes',
  3: 'wire-magic-mismatch',
  4: 'wire-length-invalid',
  5: 'wire-digest-mismatch',
  6: 'wire-version-mismatch',
  7: 'wire-operation-invalid',
  8: 'wire-authority-invalid',
  9: 'wire-parameter-invalid',
  10: 'wire-type-arguments-invalid',
  11: 'wire-result-invalid',
})

export function createStandaloneMinimalStdRequest({
  abi,
  bundle,
  corpus,
  entry,
  package_digest,
} = {}) {
  try {
    validateAuthorityInputs({ abi, bundle, corpus, package_digest })
    const index = corpus.cases.findIndex(({ id }) => id === entry?.id)
    if (index < 0 || !canonicalEqual(entry, corpus.cases[index])) {
      fail('standalone-minimal-std-entry-authority-mismatch')
    }
    const workload = bundle.workloads[index]
    if (workload.id !== entry.id || workload.operation !== entry.operation) {
      fail('standalone-minimal-std-bundle-authority-mismatch')
    }
    const parameters = parametersFromWitness(entry.parameter_witness)
    const oracle = executeMinimalStdOperation({
      graph_revision: corpus.graph_revision,
      operation: entry.operation,
      package_manifest: minimalStdPackageManifest(),
      parameters,
      schema: 're.minimal-std-invocation@0.1.0',
      type_arguments: entry.type_arguments,
    })
    if (!oracle.ok) return oracle
    if (oracle.value.invocation_digest !== workload.request_digest
      || oracle.value.receipt_digest !== workload.receipt_digest) {
      fail('standalone-minimal-std-oracle-authority-mismatch')
    }
    const parameterPayload = encodeOperationParameters(
      entry.operation,
      parameters,
    )
    const request = {
      bundle_digest: bundle.bundle_digest,
      invocation_digest: oracle.value.invocation_digest,
      operation: entry.operation,
      operation_code: OPERATION_CODES.get(entry.operation),
      oracle_receipt_digest: oracle.value.receipt_digest,
      package_digest,
      parameter_payload_base64: parameterPayload.toString('base64'),
      parameter_payload_digest: digestBytes(parameterPayload),
      parameter_witness: structuredClone(entry.parameter_witness),
      parameter_witness_digest: digestValue(entry.parameter_witness),
      schema: STANDALONE_MINIMAL_STD_REQUEST_SCHEMA,
      type_arguments: structuredClone(entry.type_arguments),
      type_arguments_digest: digestValue(entry.type_arguments),
      workload_id: entry.id,
    }
    request.request_digest = standaloneMinimalStdRequestDigest(request)
    validateRequest(request)
    return { ok: true, value: request }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-minimal-std-request-invalid')
  }
}

export async function runStandaloneMinimalStdConformance(inputs = {}) {
  let root = null
  try {
    validateInputs(inputs)
    root = await mkdtemp(join(tmpdir(), 're-standalone-minimal-std-'))
    const built = await buildExecutable({
      compiler_path: inputs.compiler_path,
      root,
      target_triple: inputs.target_triple,
    })
    const workloads = []
    for (const entry of inputs.corpus.cases) {
      const request = createStandaloneMinimalStdRequest({
        abi: inputs.abi,
        bundle: inputs.bundle,
        corpus: inputs.corpus,
        entry,
        package_digest: inputs.package_digest,
      })
      if (!request.ok) return request
      const wire = buildStandaloneMinimalStdWire(request.value)
      const executed = executeWire(built.executable_path, wire)
      if (!executed.ok) return executed
      const receipt = createReceipt({
        parsed: executed.value,
        response_wire: executed.response_wire,
      })
      const oracle = oracleForEntry(inputs.corpus, entry)
      if (!oracle.ok) return oracle
      if (!canonicalEqual(receipt.result, nativeResult(
        entry.operation,
        oracle.value.outcome,
      ))) {
        fail('standalone-minimal-std-semantic-mismatch')
      }
      const workload = {
        executable_digest: built.executable_digest,
        id: entry.id,
        operation: entry.operation,
        receipt,
        request: request.value,
        request_wire_digest: digestBytes(wire),
        response_wire_digest: digestBytes(executed.response_wire),
      }
      workload.workload_digest = standaloneMinimalStdWorkloadDigest(workload)
      workloads.push(workload)
    }
    const report = {
      bundle_digest: inputs.bundle.bundle_digest,
      candidate: 'standalone-c11',
      executable_digest: built.executable_digest,
      package_digest: inputs.package_digest,
      profile: STANDALONE_MINIMAL_STD_PROFILE,
      provenance: await compilerProvenance(inputs),
      schema: STANDALONE_MINIMAL_STD_REPORT_SCHEMA,
      source_digest: built.source_digest,
      status: 'measured',
      target_triple: inputs.target_triple,
      wire_schema: STANDALONE_MINIMAL_STD_WIRE_SCHEMA,
      workloads,
    }
    report.report_digest = standaloneMinimalStdReportDigest(report)
    const verified = await verifyStandaloneMinimalStdReport(report, inputs)
    return verified.ok ? { ok: true, value: report } : verified
  } catch (error) {
    return rejected(error?.code ?? 'standalone-minimal-std-runner-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function verifyStandaloneMinimalStdReport(report, inputs = {}) {
  let root = null
  try {
    validateInputs(inputs)
    validateReport(report)
    if (report.package_digest !== inputs.package_digest
      || report.bundle_digest !== inputs.bundle.bundle_digest
      || report.target_triple !== inputs.target_triple
      || report.source_digest !== digestBytes(
        Buffer.from(standaloneMinimalStdCSource(), 'utf8'),
      )) {
      fail('standalone-minimal-std-report-authority-mismatch')
    }
    const provenance = await compilerProvenance(inputs)
    if (!canonicalEqual(report.provenance, provenance)) {
      fail('standalone-minimal-std-compiler-mismatch')
    }
    root = await mkdtemp(join(tmpdir(), 're-standalone-minimal-std-verify-'))
    const built = await buildExecutable({
      compiler_path: inputs.compiler_path,
      root,
      target_triple: inputs.target_triple,
    })
    if (built.executable_digest !== report.executable_digest) {
      fail('standalone-minimal-std-executable-mismatch')
    }
    if (report.workloads.length !== inputs.corpus.cases.length) {
      fail('standalone-minimal-std-workload-set-mismatch')
    }
    for (let index = 0; index < inputs.corpus.cases.length; index += 1) {
      const entry = inputs.corpus.cases[index]
      const actual = report.workloads[index]
      const expectedRequest = createStandaloneMinimalStdRequest({
        abi: inputs.abi,
        bundle: inputs.bundle,
        corpus: inputs.corpus,
        entry,
        package_digest: inputs.package_digest,
      })
      if (!expectedRequest.ok) return expectedRequest
      const wire = buildStandaloneMinimalStdWire(expectedRequest.value)
      const executed = executeWire(built.executable_path, wire)
      if (!executed.ok) return executed
      const receipt = createReceipt({
        parsed: executed.value,
        response_wire: executed.response_wire,
      })
      const oracle = oracleForEntry(inputs.corpus, entry)
      if (!oracle.ok) return oracle
      if (actual.id !== entry.id
        || actual.operation !== entry.operation
        || actual.executable_digest !== report.executable_digest
        || !canonicalEqual(actual.request, expectedRequest.value)
        || actual.request_wire_digest !== digestBytes(wire)
        || actual.response_wire_digest !== digestBytes(executed.response_wire)
        || !canonicalEqual(actual.receipt, receipt)
        || !canonicalEqual(
          actual.receipt.result,
          nativeResult(entry.operation, oracle.value.outcome),
        )
        || actual.workload_digest
          !== standaloneMinimalStdWorkloadDigest(actual)) {
        fail('standalone-minimal-std-workload-authority-mismatch')
      }
    }
    if (report.report_digest !== standaloneMinimalStdReportDigest(report)) {
      fail('standalone-minimal-std-report-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-minimal-std-report-invalid')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function runStandaloneMinimalStdWire({
  compiler_path,
  signal,
  timeout_ms = DEFAULT_EXECUTION_TIMEOUT_MS,
  target_triple,
  wire,
} = {}) {
  let root = null
  try {
    if (!isAbsolute(compiler_path)
      || typeof target_triple !== 'string'
      || !Buffer.isBuffer(wire)) {
      fail('standalone-minimal-std-input-invalid')
    }
    root = await mkdtemp(join(tmpdir(), 're-standalone-minimal-std-wire-'))
    const built = await buildExecutable({ compiler_path, root, target_triple })
    return await runStandaloneMinimalStdExecutable({
      executable_path: built.executable_path,
      signal,
      timeout_ms,
      wire,
    })
  } catch (error) {
    return rejected(error?.code ?? 'standalone-minimal-std-wire-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function runStandaloneMinimalStdExecutable({
  executable_path,
  signal,
  timeout_ms = DEFAULT_EXECUTION_TIMEOUT_MS,
  wire,
} = {}) {
  try {
    if (!isAbsolute(executable_path) || !Buffer.isBuffer(wire)) {
      fail('standalone-minimal-std-execution-input-invalid')
    }
    if (!Number.isSafeInteger(timeout_ms)
      || timeout_ms <= 0
      || timeout_ms > MAX_EXECUTION_TIMEOUT_MS) {
      fail('standalone-minimal-std-execution-timeout-invalid')
    }
    const signalAuthority = captureExecutionSignal(signal)
    if (signalAuthority?.initial_aborted) {
      return rejected('standalone-minimal-std-execution-cancelled')
    }

    const child = spawn(executable_path, [], {
      detached: platform() !== 'win32',
      encoding: null,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return await collectStandaloneMinimalStdChild({
      child,
      signalAuthority,
      timeout_ms,
      wire,
    })
  } catch (error) {
    return rejected(error?.code ?? 'standalone-minimal-std-execution-failed')
  }
}

export function buildStandaloneMinimalStdWire(request) {
  validateRequest(request)
  const parameterPayload = Buffer.from(
    request.parameter_payload_base64,
    'base64',
  )
  const fixed = Buffer.alloc(4)
  fixed.writeUInt16LE(2, 0)
  fixed.writeUInt8(request.operation_code, 2)
  fixed.writeUInt8(0, 3)
  const payload = Buffer.concat([
    fixed,
    ...[
      request.package_digest,
      request.bundle_digest,
      request.workload_id,
      request.operation,
      request.invocation_digest,
      request.oracle_receipt_digest,
      request.parameter_witness_digest,
      request.type_arguments_digest,
      request.parameter_payload_digest,
      request.request_digest,
      canonicalJson(request.type_arguments),
    ].map(fieldBytes),
    fieldBytes(parameterPayload),
    fieldBytes(canonicalJson(request.parameter_witness)),
  ])
  return frame(REQUEST_MAGIC, payload)
}

export function standaloneMinimalStdRequestDigest(request) {
  const { request_digest: ignored, ...content } = request
  return digestValue(content)
}

export function standaloneMinimalStdReceiptDigest(receipt) {
  const { receipt_digest: ignored, ...content } = receipt
  return digestValue(content)
}

export function standaloneMinimalStdWorkloadDigest(workload) {
  const { workload_digest: ignored, ...content } = workload
  return digestValue(content)
}

export function standaloneMinimalStdReportDigest(report) {
  const { report_digest: ignored, ...content } = report
  return digestValue(content)
}

export function standaloneMinimalStdCSource() {
  return `${standalonePortableVmSha256CSource()}
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HEADER_SIZE 44u
#define MAX_PAYLOAD 65535u
#define MAX_FIELD 4096u

typedef struct {
  const unsigned char *p;
  unsigned n;
} slice;
typedef struct {
  unsigned char *p;
  unsigned n;
  unsigned cap;
} output;

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
static int same(slice value, const char *text) {
  size_t n = strlen(text);
  return value.n == n && memcmp(value.p, text, n) == 0;
}
static int digest_field(slice value) {
  if (value.n != 71u || memcmp(value.p, "sha256:", 7u) != 0) return 0;
  for (unsigned i = 7u; i < value.n; i++) {
    if (!((value.p[i] >= '0' && value.p[i] <= '9')
        || (value.p[i] >= 'a' && value.p[i] <= 'f'))) return 0;
  }
  return 1;
}
static int field(const unsigned char *payload, unsigned size, unsigned *offset,
  slice *value) {
  if (*offset + 2u > size) return 0;
  value->n = read_u16(payload + *offset);
  *offset += 2u;
  if (value->n > MAX_FIELD || *offset + value->n > size) return 0;
  value->p = payload + *offset;
  *offset += value->n;
  return 1;
}
static int out_bytes(output *out, const void *bytes, unsigned n) {
  if (out->n + n > out->cap) return 0;
  memcpy(out->p + out->n, bytes, n);
  out->n += n;
  return 1;
}
static int out_char(output *out, unsigned char value) {
  return out_bytes(out, &value, 1u);
}
static int out_text(output *out, const char *text) {
  return out_bytes(out, text, (unsigned)strlen(text));
}
static int out_uint(output *out, unsigned value) {
  char text[32];
  int n = snprintf(text, sizeof(text), "%u", value);
  return n > 0 && out_bytes(out, text, (unsigned)n);
}
static int out_hex(output *out, slice value) {
  static const char hex[] = "0123456789abcdef";
  for (unsigned i = 0u; i < value.n; i++) {
    if (!out_char(out, (unsigned char)hex[value.p[i] >> 4])
      || !out_char(out, (unsigned char)hex[value.p[i] & 15u])) return 0;
  }
  return 1;
}
static int utf8(slice value, unsigned *count) {
  unsigned index = 0u, scalars = 0u;
  while (index < value.n) {
    unsigned byte = value.p[index], width = 0u, code = 0u;
    if (byte <= 0x7fu) { width = 1u; code = byte; }
    else if (byte >= 0xc2u && byte <= 0xdfu) { width = 2u; code = byte & 31u; }
    else if (byte >= 0xe0u && byte <= 0xefu) { width = 3u; code = byte & 15u; }
    else if (byte >= 0xf0u && byte <= 0xf4u) { width = 4u; code = byte & 7u; }
    else return 0;
    if (index + width > value.n) return 0;
    for (unsigned offset = 1u; offset < width; offset++) {
      unsigned continuation = value.p[index + offset];
      if ((continuation & 0xc0u) != 0x80u) return 0;
      code = (code << 6) | (continuation & 63u);
    }
    if ((width == 2u && code < 0x80u)
      || (width == 3u && code < 0x800u)
      || (width == 4u && code < 0x10000u)
      || code > 0x10ffffu
      || (code >= 0xd800u && code <= 0xdfffu)) return 0;
    index += width;
    scalars += 1u;
  }
  if (count != NULL) *count = scalars;
  return 1;
}
static int out_json_string(output *out, slice value) {
  if (!utf8(value, NULL) || !out_char(out, 34u)) return 0;
  for (unsigned i = 0u; i < value.n; i++) {
    unsigned char byte = value.p[i];
    if (byte == 34u || byte == 92u) {
      if (!out_char(out, 92u) || !out_char(out, byte)) return 0;
    } else if (byte == 8u) { if (!out_text(out, "\\\\b")) return 0; }
    else if (byte == 12u) { if (!out_text(out, "\\\\f")) return 0; }
    else if (byte == 10u) { if (!out_text(out, "\\\\n")) return 0; }
    else if (byte == 13u) { if (!out_text(out, "\\\\r")) return 0; }
    else if (byte == 9u) { if (!out_text(out, "\\\\t")) return 0; }
    else if (byte < 32u) {
      char escaped[7];
      int n = snprintf(escaped, sizeof(escaped), "\\\\u%04x", byte);
      if (n != 6 || !out_bytes(out, escaped, 6u)) return 0;
    } else if (!out_char(out, byte)) return 0;
  }
  return out_char(out, 34u);
}
static int param(slice payload, unsigned *offset, unsigned expected_kind,
  const char *expected_name, slice *value) {
  if (*offset + 2u > payload.n) return 0;
  unsigned name_size = payload.p[(*offset)++];
  if (*offset + name_size + 1u > payload.n) return 0;
  slice name = {payload.p + *offset, name_size};
  *offset += name_size;
  unsigned kind = payload.p[(*offset)++];
  if (!same(name, expected_name) || kind != expected_kind) return 0;
  if (kind == 4u) {
    if (*offset + 1u > payload.n || payload.p[*offset] > 1u) return 0;
    value->p = payload.p + *offset;
    value->n = 1u;
    *offset += 1u;
    return 1;
  }
  if (*offset + 2u > payload.n) return 0;
  unsigned size = read_u16(payload.p + *offset);
  *offset += 2u;
  if (*offset + size > payload.n) return 0;
  value->p = payload.p + *offset;
  value->n = size;
  *offset += size;
  return kind != 2u || utf8(*value, NULL);
}
static int list_item(slice list, unsigned *offset, slice *value) {
  if (*offset + 2u > list.n) return 0;
  unsigned size = read_u16(list.p + *offset);
  *offset += 2u;
  if (*offset + size > list.n) return 0;
  value->p = list.p + *offset;
  value->n = size;
  *offset += size;
  return utf8(*value, NULL);
}
static int out_list(output *out, slice list, const slice *append) {
  if (list.n < 2u) return 0;
  unsigned count = read_u16(list.p), offset = 2u;
  if (!out_text(out, "{\\"kind\\":\\"list\\",\\"value\\":[")) return 0;
  for (unsigned i = 0u; i < count; i++) {
    slice item;
    if (!list_item(list, &offset, &item)
      || (i > 0u && !out_char(out, ',')) || !out_json_string(out, item)) return 0;
  }
  if (offset != list.n) return 0;
  if (append != NULL) {
    if (count > 0u && !out_char(out, ',')) return 0;
    if (!out_json_string(out, *append)) return 0;
  }
  return out_text(out, "]}");
}
static int operation_matches(unsigned opcode, slice operation) {
  static const char *names[] = {
    "", "std.bytes.byte_count", "std.bytes.concat", "std.bytes.decode_utf8",
    "std.list.append", "std.list.concat", "std.list.length",
    "std.result.is_err", "std.result.is_ok", "std.text.concat",
    "std.text.encode_utf8", "std.text.scalar_count"
  };
  return opcode >= 1u && opcode <= 11u && same(operation, names[opcode]);
}
static int type_arguments_match(unsigned opcode, slice value) {
  if (opcode >= 4u && opcode <= 6u) return same(value, "[\\"text.utf8\\"]");
  if (opcode == 7u || opcode == 8u) {
    return same(value, "[\\"text.utf8\\",\\"std.bytes.decode_error\\"]");
  }
  return same(value, "[]");
}
static int execute(unsigned opcode, slice parameters, output *result) {
  if (parameters.n < 1u) return 0;
  unsigned count = parameters.p[0], offset = 1u;
  slice a = {0}, b = {0};
  switch (opcode) {
    case 1u:
      if (count != 1u || !param(parameters, &offset, 1u, "value", &a)
        || offset != parameters.n) return 0;
      return out_text(result, "{\\"kind\\":\\"int\\",\\"value\\":\\"")
        && out_uint(result, a.n) && out_text(result, "\\"}");
    case 2u:
      if (count != 2u || !param(parameters, &offset, 1u, "left", &a)
        || !param(parameters, &offset, 1u, "right", &b)
        || offset != parameters.n) return 0;
      return out_text(result, "{\\"kind\\":\\"bytes\\",\\"value\\":\\"")
        && out_hex(result, a) && out_hex(result, b) && out_text(result, "\\"}");
    case 3u: {
      if (count != 1u || !param(parameters, &offset, 1u, "value", &a)
        || offset != parameters.n) return 0;
      if (!utf8(a, NULL)) {
        return out_text(result, "{\\"kind\\":\\"result\\",\\"value\\":{\\"error\\":{\\"type\\":\\"std.bytes.decode_error\\",\\"variant\\":\\"invalid_utf8\\"},\\"kind\\":\\"err\\"}}");
      }
      return out_text(result, "{\\"kind\\":\\"result\\",\\"value\\":{\\"kind\\":\\"ok\\",\\"value\\":")
        && out_json_string(result, a) && out_text(result, "}}");
    }
    case 4u:
      if (count != 2u || !param(parameters, &offset, 3u, "values", &a)
        || !param(parameters, &offset, 2u, "value", &b)
        || offset != parameters.n) return 0;
      return out_list(result, a, &b);
    case 5u: {
      if (count != 2u || !param(parameters, &offset, 3u, "left", &a)
        || !param(parameters, &offset, 3u, "right", &b)
        || offset != parameters.n || a.n < 2u || b.n < 2u) return 0;
      unsigned left_count = read_u16(a.p), right_count = read_u16(b.p);
      if (!out_text(result, "{\\"kind\\":\\"list\\",\\"value\\":[")) return 0;
      unsigned list_offset = 2u;
      for (unsigned i = 0u; i < left_count; i++) {
        slice item;
        if (!list_item(a, &list_offset, &item)
          || (i > 0u && !out_char(result, ',')) || !out_json_string(result, item)) return 0;
      }
      if (list_offset != a.n) return 0;
      list_offset = 2u;
      for (unsigned i = 0u; i < right_count; i++) {
        slice item;
        if (!list_item(b, &list_offset, &item)
          || ((left_count + i) > 0u && !out_char(result, ','))
          || !out_json_string(result, item)) return 0;
      }
      return list_offset == b.n && out_text(result, "]}");
    }
    case 6u:
      if (count != 1u || !param(parameters, &offset, 3u, "values", &a)
        || offset != parameters.n || a.n < 2u) return 0;
      {
        unsigned list_count = read_u16(a.p), list_offset = 2u;
        for (unsigned i = 0u; i < list_count; i++) {
          slice item;
          if (!list_item(a, &list_offset, &item)) return 0;
        }
        return list_offset == a.n
          && out_text(result, "{\\"kind\\":\\"int\\",\\"value\\":\\"")
          && out_uint(result, list_count) && out_text(result, "\\"}");
      }
    case 7u:
    case 8u:
      if (count != 1u || !param(parameters, &offset, 4u, "value", &a)
        || offset != parameters.n) return 0;
      return out_text(result, "{\\"kind\\":\\"bool\\",\\"value\\":")
        && out_text(result, (opcode == 7u ? a.p[0] : !a.p[0]) ? "true" : "false")
        && out_char(result, '}');
    case 9u:
      if (count != 2u || !param(parameters, &offset, 2u, "left", &a)
        || !param(parameters, &offset, 2u, "right", &b)
        || offset != parameters.n) return 0;
      if (!out_text(result, "{\\"kind\\":\\"text\\",\\"value\\":\\"")) return 0;
      for (unsigned i = 0u; i < 2u; i++) {
        slice value = i == 0u ? a : b;
        for (unsigned j = 0u; j < value.n; j++) {
          unsigned char byte = value.p[j];
          if (byte == 34u || byte == 92u) {
            if (!out_char(result, 92u) || !out_char(result, byte)) return 0;
          } else if (byte == 10u) { if (!out_text(result, "\\\\n")) return 0; }
          else if (byte == 13u) { if (!out_text(result, "\\\\r")) return 0; }
          else if (byte == 9u) { if (!out_text(result, "\\\\t")) return 0; }
          else if (byte < 32u) {
            char escaped[7];
            int n = snprintf(escaped, sizeof(escaped), "\\\\u%04x", byte);
            if (n != 6 || !out_bytes(result, escaped, 6u)) return 0;
          } else if (!out_char(result, byte)) return 0;
        }
      }
      return out_text(result, "\\"}");
    case 10u:
      if (count != 1u || !param(parameters, &offset, 2u, "value", &a)
        || offset != parameters.n) return 0;
      return out_text(result, "{\\"kind\\":\\"bytes\\",\\"value\\":\\"")
        && out_hex(result, a) && out_text(result, "\\"}");
    case 11u: {
      unsigned scalars = 0u;
      if (count != 1u || !param(parameters, &offset, 2u, "value", &a)
        || offset != parameters.n || !utf8(a, &scalars)) return 0;
      return out_text(result, "{\\"kind\\":\\"int\\",\\"value\\":\\"")
        && out_uint(result, scalars) && out_text(result, "\\"}");
    }
    default:
      return 0;
  }
}
static int append_field(output *out, slice value) {
  unsigned char size[2];
  if (value.n > MAX_FIELD) return 0;
  write_u16(size, value.n);
  return out_bytes(out, size, 2u) && out_bytes(out, value.p, value.n);
}
static int fail_wire(unsigned code) {
  printf("RESTERR1:%u\\n", code);
  return 70;
}
int main(void) {
  unsigned char input[HEADER_SIZE + MAX_PAYLOAD + 1u];
  size_t count = fread(input, 1u, sizeof(input), stdin);
  if (count < HEADER_SIZE) return fail_wire(1u);
  if (memcmp(input, "RESTREQ1", 8u) != 0) return fail_wire(3u);
  unsigned payload_size = read_u32(input + 8u);
  if (payload_size > MAX_PAYLOAD) return fail_wire(4u);
  if (count < HEADER_SIZE + payload_size) return fail_wire(1u);
  if (count > HEADER_SIZE + payload_size) return fail_wire(2u);
  unsigned char digest[32];
  sha256(input + HEADER_SIZE, payload_size, digest);
  if (memcmp(digest, input + 12u, 32u) != 0) return fail_wire(5u);
  const unsigned char *payload = input + HEADER_SIZE;
  if (payload_size < 4u || read_u16(payload) != 2u || payload[3] != 0u) {
    return fail_wire(6u);
  }
  unsigned opcode = payload[2], offset = 4u;
  if (opcode < 1u || opcode > 11u) return fail_wire(7u);
  slice values[13];
  for (unsigned i = 0u; i < 13u; i++) {
    if (!field(payload, payload_size, &offset, &values[i])) {
      return fail_wire(8u);
    }
  }
  if (offset != payload_size || !digest_field(values[0])
    || !digest_field(values[1]) || !digest_field(values[4])
    || !digest_field(values[5]) || !digest_field(values[6])
    || !digest_field(values[7]) || !digest_field(values[8])
    || !digest_field(values[9])) return fail_wire(8u);
  if (!operation_matches(opcode, values[3])) return fail_wire(7u);
  if (!type_arguments_match(opcode, values[10])) return fail_wire(10u);
  unsigned char parameter_digest[32];
  sha256(values[11].p, values[11].n, parameter_digest);
  char parameter_digest_text[72] = "sha256:";
  static const char hex[] = "0123456789abcdef";
  for (unsigned i = 0u; i < 32u; i++) {
    parameter_digest_text[7u + i * 2u] = hex[parameter_digest[i] >> 4];
    parameter_digest_text[8u + i * 2u] = hex[parameter_digest[i] & 15u];
  }
  parameter_digest_text[71] = 0;
  if (!same(values[8], parameter_digest_text)) return fail_wire(8u);
  unsigned char witness_digest[32];
  sha256(values[12].p, values[12].n, witness_digest);
  char witness_digest_text[72] = "sha256:";
  for (unsigned i = 0u; i < 32u; i++) {
    witness_digest_text[7u + i * 2u] = hex[witness_digest[i] >> 4];
    witness_digest_text[8u + i * 2u] = hex[witness_digest[i] & 15u];
  }
  witness_digest_text[71] = 0;
  if (!same(values[6], witness_digest_text)) return fail_wire(8u);
  unsigned char result_bytes[MAX_FIELD];
  output result = {result_bytes, 0u, MAX_FIELD};
  if (!execute(opcode, values[11], &result)) return fail_wire(9u);
  unsigned char response[MAX_PAYLOAD];
  output response_out = {response, 0u, MAX_PAYLOAD};
  unsigned char fixed[4] = {2u, 0u, 1u, (unsigned char)opcode};
  if (!out_bytes(&response_out, fixed, 4u)) return fail_wire(11u);
  for (unsigned i = 0u; i < 10u; i++) {
    if (!append_field(&response_out, values[i])) return fail_wire(11u);
  }
  slice result_slice = {result.p, result.n};
  if (!append_field(&response_out, result_slice)) return fail_wire(11u);
  unsigned char header[HEADER_SIZE];
  memcpy(header, "RESTRES1", 8u);
  write_u32(header + 8u, response_out.n);
  sha256(response, response_out.n, header + 12u);
  if (fwrite(header, 1u, HEADER_SIZE, stdout) != HEADER_SIZE
    || fwrite(response, 1u, response_out.n, stdout) != response_out.n) return 74;
  return 0;
}
`
}

async function buildExecutable({ compiler_path, root, target_triple }) {
  const source = standaloneMinimalStdCSource()
  const source_path = join(root, 'standalone-minimal-std.c')
  const executable_path = join(
    root,
    platform() === 'win32'
      ? 'standalone-minimal-std.exe'
      : 'standalone-minimal-std',
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
    fail('standalone-minimal-std-compiler-missing')
  }
  if (built.error || built.status !== 0) {
    fail('standalone-minimal-std-compile-failed')
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
  const interpreted = interpretStandaloneMinimalStdChild({
    error: executed.error,
    stderr: Buffer.from(executed.stderr ?? []),
    stdout: Buffer.from(executed.stdout ?? []),
    status: executed.status,
  })
  if (!interpreted.ok) return interpreted
  const stdout = interpreted.value
  try {
    const value = parseResponseWire(stdout)
    verifyResponseAuthority(value, wire)
    return {
      ok: true,
      response_wire: stdout,
      value,
    }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-minimal-std-response-invalid')
  }
}

function collectStandaloneMinimalStdChild({
  child,
  signalAuthority,
  timeout_ms,
  wire,
}) {
  return new Promise((resolve) => {
    let settled = false
    let spawned = false
    let terminal = null
    let timer = null
    let listenerRegistered = false
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) {
        try {
          clearTimeout(timer)
        } catch {}
      }
      if (listenerRegistered) {
        try {
          signalAuthority.remove(onAbort)
        } catch {
          if (result.ok) {
            result = rejected(
              'standalone-minimal-std-execution-signal-failed',
            )
          }
        }
      }
      resolve(result)
    }
    const killSpawnedChild = () => {
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      if (platform() !== 'win32' && Number.isSafeInteger(child.pid)) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }
      try {
        child.kill('SIGKILL')
      } catch {}
    }
    const terminate = (code) => {
      if (settled || terminal !== null) return
      terminal = code
      if (spawned) killSpawnedChild()
    }
    const onAbort = () => terminate('standalone-minimal-std-execution-cancelled')
    child.stdout.on('data', (chunk) => {
      if (terminal !== null) return
      const bytes = Buffer.from(chunk)
      if (bytes.length > MAX_EXECUTION_OUTPUT_BYTES - stdout.length) {
        terminate('standalone-minimal-std-execution-output-too-large')
        return
      }
      stdout = Buffer.concat([stdout, bytes])
    })
    child.stderr.on('data', (chunk) => {
      if (terminal !== null) return
      const bytes = Buffer.from(chunk)
      if (bytes.length > MAX_EXECUTION_OUTPUT_BYTES - stderr.length) {
        terminate('standalone-minimal-std-execution-output-too-large')
        return
      }
      stderr = Buffer.concat([stderr, bytes])
    })
    child.stdout.once('error', () => {
      terminate('standalone-minimal-std-execution-failed')
    })
    child.stderr.once('error', () => {
      terminate('standalone-minimal-std-execution-failed')
    })
    child.once('spawn', () => {
      spawned = true
      if (terminal !== null) killSpawnedChild()
    })
    child.once('error', () => {
      if (!spawned) {
        finish(rejected('standalone-minimal-std-spawn-failed'))
      } else if (terminal === null) {
        terminal = 'standalone-minimal-std-execution-failed'
      }
    })
    child.once('close', (status, signalName) => {
      if (terminal !== null) {
        finish(rejected(terminal))
        return
      }
      const interpreted = interpretStandaloneMinimalStdChild({
        error: null,
        signal: signalName,
        stderr,
        stdout,
        status,
      })
      if (!interpreted.ok) {
        finish(interpreted)
        return
      }
      try {
        const value = parseResponseWire(interpreted.value)
        verifyResponseAuthority(value, wire)
        finish({
          ok: true,
          response_wire: interpreted.value,
          value,
        })
      } catch (error) {
        finish(rejected(
          error?.code ?? 'standalone-minimal-std-response-invalid',
        ))
      }
    })
    child.stdin.once('error', () => {})
    if (signalAuthority !== null) {
      try {
        listenerRegistered = true
        signalAuthority.add(onAbort)
      } catch {
        terminate('standalone-minimal-std-execution-signal-failed')
      }
      if (terminal === null) {
        try {
          if (signalAuthority.aborted()) onAbort()
        } catch {
          terminate('standalone-minimal-std-execution-signal-failed')
        }
      }
    }
    if (terminal === null) {
      timer = setTimeout(
        () => terminate('standalone-minimal-std-execution-timeout'),
        timeout_ms,
      )
      child.stdin.end(wire)
    }
  })
}

function captureExecutionSignal(signal) {
  if (signal === undefined) return null
  if (signal === null) fail('standalone-minimal-std-execution-signal-invalid')
  let aborted
  let addEventListener
  let removeEventListener
  try {
    aborted = signal.aborted
    addEventListener = signal.addEventListener
    removeEventListener = signal.removeEventListener
  } catch {
    fail('standalone-minimal-std-execution-signal-failed')
  }
  if (typeof aborted !== 'boolean'
    || typeof addEventListener !== 'function'
    || typeof removeEventListener !== 'function') {
    fail('standalone-minimal-std-execution-signal-invalid')
  }
  return {
    aborted() {
      const current = signal.aborted
      if (typeof current !== 'boolean') {
        fail('standalone-minimal-std-execution-signal-failed')
      }
      return current
    },
    add(listener) {
      Reflect.apply(addEventListener, signal, ['abort', listener, { once: true }])
    },
    initial_aborted: aborted,
    remove(listener) {
      Reflect.apply(removeEventListener, signal, ['abort', listener])
    },
  }
}

function interpretStandaloneMinimalStdChild({
  error,
  signal = null,
  stderr,
  stdout,
  status,
}) {
  if (error?.code === 'ENOENT') {
    return rejected('standalone-minimal-std-spawn-failed')
  }
  if (signal !== null) {
    return rejected('standalone-minimal-std-execution-signalled')
  }
  if (stderr.length !== 0) {
    return rejected('standalone-minimal-std-execution-stderr')
  }
  if (status !== 0) {
    const match = stdout.toString('ascii').match(/^RESTERR1:([0-9]+)\n$/u)
    return rejected(ERROR_CODES[Number(match?.[1])]
      ?? 'standalone-minimal-std-execution-failed')
  }
  if (error) {
    return rejected('standalone-minimal-std-execution-failed')
  }
  return { ok: true, value: stdout }
}

function parseResponseWire(wire) {
  if (wire.length < HEADER_BYTES) fail('standalone-minimal-std-response-truncated')
  if (!wire.subarray(0, 8).equals(RESPONSE_MAGIC)) {
    fail('standalone-minimal-std-response-magic-mismatch')
  }
  const length = wire.readUInt32LE(8)
  if (wire.length !== HEADER_BYTES + length || length > MAX_PAYLOAD_BYTES) {
    fail('standalone-minimal-std-response-length-mismatch')
  }
  const payload = wire.subarray(HEADER_BYTES)
  if (!sha256(payload).equals(wire.subarray(12, 44))) {
    fail('standalone-minimal-std-response-digest-mismatch')
  }
  if (payload.length < 4 || payload.readUInt16LE(0) !== 2 || payload[2] !== 1) {
    fail('standalone-minimal-std-response-version-mismatch')
  }
  let offset = 4
  const fields = []
  for (let index = 0; index < 11; index += 1) {
    if (offset + 2 > payload.length) {
      fail('standalone-minimal-std-response-invalid')
    }
    const size = payload.readUInt16LE(offset)
    offset += 2
    if (size > 4096 || offset + size > payload.length) {
      fail('standalone-minimal-std-response-invalid')
    }
    fields.push(payload.subarray(offset, offset + size))
    offset += size
  }
  if (offset !== payload.length) fail('standalone-minimal-std-response-invalid')
  const text = fields.slice(0, 10).map((value) => value.toString('utf8'))
  if (![0, 1, 4, 5, 6, 7, 8, 9].every((index) => DIGEST.test(text[index]))) {
    fail('standalone-minimal-std-response-invalid')
  }
  let result
  try {
    result = JSON.parse(fields[10].toString('utf8'))
  } catch {
    fail('standalone-minimal-std-response-invalid')
  }
  return {
    bundle_digest: text[1],
    invocation_digest: text[4],
    operation: text[3],
    operation_code: payload[3],
    oracle_receipt_digest: text[5],
    package_digest: text[0],
    parameter_payload_digest: text[8],
    parameter_witness_digest: text[6],
    request_digest: text[9],
    result,
    type_arguments_digest: text[7],
    workload_id: text[2],
  }
}

function verifyResponseAuthority(response, wire) {
  const request = parseRequestAuthority(wire)
  for (const key of [
    'package_digest',
    'bundle_digest',
    'workload_id',
    'operation',
    'invocation_digest',
    'oracle_receipt_digest',
    'parameter_witness_digest',
    'type_arguments_digest',
    'parameter_payload_digest',
    'request_digest',
  ]) {
    if (response[key] !== request[key]) {
      fail('standalone-minimal-std-response-authority-mismatch')
    }
  }
  if (response.operation_code !== request.operation_code) {
    fail('standalone-minimal-std-response-authority-mismatch')
  }
}

function parseRequestAuthority(wire) {
  try {
    if (!Buffer.isBuffer(wire)
      || wire.length < HEADER_BYTES
      || !wire.subarray(0, 8).equals(REQUEST_MAGIC)) {
      throw new Error('invalid request framing')
    }
    const length = wire.readUInt32LE(8)
    if (length > MAX_PAYLOAD_BYTES || wire.length !== HEADER_BYTES + length) {
      throw new Error('invalid request length')
    }
    const payload = wire.subarray(HEADER_BYTES)
    if (!sha256(payload).equals(wire.subarray(12, 44))
      || payload.length < 4
      || payload.readUInt16LE(0) !== 2
      || payload[3] !== 0) {
      throw new Error('invalid request authority')
    }
    let offset = 4
    const fields = []
    for (let index = 0; index < 13; index += 1) {
      if (offset + 2 > payload.length) throw new Error('truncated request')
      const size = payload.readUInt16LE(offset)
      offset += 2
      if (size > 4096 || offset + size > payload.length) {
        throw new Error('invalid request field')
      }
      fields.push(payload.subarray(offset, offset + size))
      offset += size
    }
    if (offset !== payload.length) throw new Error('extra request bytes')
    const text = fields.slice(0, 11).map((value) => value.toString('utf8'))
    if (text.some((value, index) =>
      !Buffer.from(value, 'utf8').equals(fields[index]))) {
      throw new Error('invalid request utf8')
    }
    if (![0, 1, 4, 5, 6, 7, 8, 9].every((index) => DIGEST.test(text[index]))) {
      throw new Error('invalid request digest field')
    }
    let parameterWitness
    let typeArguments
    try {
      typeArguments = JSON.parse(text[10])
      parameterWitness = JSON.parse(fields[12].toString('utf8'))
    } catch {
      throw new Error('invalid request json authority')
    }
    if (canonicalJson(typeArguments) !== text[10]
      || canonicalJson(parameterWitness) !== fields[12].toString('utf8')) {
      throw new Error('noncanonical request json authority')
    }
    const parameterPayload = fields[11]
    const request = {
      bundle_digest: text[1],
      invocation_digest: text[4],
      operation: text[3],
      operation_code: payload[2],
      oracle_receipt_digest: text[5],
      package_digest: text[0],
      parameter_payload_base64: parameterPayload.toString('base64'),
      parameter_payload_digest: text[8],
      parameter_witness: parameterWitness,
      parameter_witness_digest: text[6],
      request_digest: text[9],
      schema: STANDALONE_MINIMAL_STD_REQUEST_SCHEMA,
      type_arguments: typeArguments,
      type_arguments_digest: text[7],
      workload_id: text[2],
    }
    validateRequest(request)
    return request
  } catch {
    fail('standalone-minimal-std-response-authority-mismatch')
  }
}

function createReceipt({ parsed, response_wire }) {
  const receipt = {
    bundle_digest: parsed.bundle_digest,
    invocation_digest: parsed.invocation_digest,
    operation: parsed.operation,
    oracle_receipt_digest: parsed.oracle_receipt_digest,
    package_digest: parsed.package_digest,
    parameter_payload_digest: parsed.parameter_payload_digest,
    parameter_witness_digest: parsed.parameter_witness_digest,
    profile: STANDALONE_MINIMAL_STD_PROFILE,
    request_digest: parsed.request_digest,
    response_wire_digest: digestBytes(response_wire),
    result: parsed.result,
    schema: STANDALONE_MINIMAL_STD_RECEIPT_SCHEMA,
    status: 'ok',
    type_arguments_digest: parsed.type_arguments_digest,
    workload_id: parsed.workload_id,
  }
  receipt.receipt_digest = standaloneMinimalStdReceiptDigest(receipt)
  return receipt
}

function encodeOperationParameters(operation, parameters) {
  const fields = []
  let parameterCount = 0
  const add = (name, kind, value) => {
    parameterCount += 1
    const nameBytes = Buffer.from(name, 'utf8')
    if (nameBytes.length > 255) fail('standalone-minimal-std-parameter-invalid')
    fields.push(Buffer.from([nameBytes.length]), nameBytes, Buffer.from([kind]))
    if (kind === 4) {
      fields.push(Buffer.from([value ? 1 : 0]))
      return
    }
    const bytes = kind === 1
      ? Buffer.from(value)
      : kind === 2
        ? Buffer.from(value, 'utf8')
        : encodeTextList(value)
    fields.push(length16(bytes), bytes)
  }
  switch (operation) {
    case 'std.bytes.byte_count':
    case 'std.bytes.decode_utf8':
      add('value', 1, parameters.value)
      break
    case 'std.bytes.concat':
      add('left', 1, parameters.left)
      add('right', 1, parameters.right)
      break
    case 'std.list.append':
      add('values', 3, parameters.values)
      add('value', 2, parameters.value)
      break
    case 'std.list.concat':
      add('left', 3, parameters.left)
      add('right', 3, parameters.right)
      break
    case 'std.list.length':
      add('values', 3, parameters.values)
      break
    case 'std.result.is_err':
    case 'std.result.is_ok':
      add('value', 4, parameters.value?.kind === 'err')
      break
    case 'std.text.concat':
      add('left', 2, parameters.left)
      add('right', 2, parameters.right)
      break
    case 'std.text.encode_utf8':
    case 'std.text.scalar_count':
      add('value', 2, parameters.value)
      break
    default:
      fail('standalone-minimal-std-operation-unknown')
  }
  return Buffer.concat([Buffer.from([parameterCount]), ...fields])
}

function encodeTextList(values) {
  if (!Array.isArray(values)
    || values.some((value) => typeof value !== 'string')
    || values.length > 65_535) {
    fail('standalone-minimal-std-parameter-invalid')
  }
  const count = Buffer.alloc(2)
  count.writeUInt16LE(values.length)
  return Buffer.concat([
    count,
    ...values.flatMap((value) => {
      const bytes = Buffer.from(value, 'utf8')
      return [length16(bytes), bytes]
    }),
  ])
}

function length16(bytes) {
  if (bytes.length > 65_535) fail('standalone-minimal-std-parameter-invalid')
  const length = Buffer.alloc(2)
  length.writeUInt16LE(bytes.length)
  return length
}

function oracleForEntry(corpus, entry) {
  return executeMinimalStdOperation({
    graph_revision: corpus.graph_revision,
    operation: entry.operation,
    package_manifest: minimalStdPackageManifest(),
    parameters: parametersFromWitness(entry.parameter_witness),
    schema: 're.minimal-std-invocation@0.1.0',
    type_arguments: entry.type_arguments,
  })
}

function nativeResult(operation, outcome) {
  if (operation === 'std.bytes.byte_count'
    || operation === 'std.list.length'
    || operation === 'std.text.scalar_count') {
    return { kind: 'int', value: outcome }
  }
  if (operation === 'std.bytes.concat'
    || operation === 'std.text.encode_utf8') {
    return {
      kind: 'bytes',
      value: [...outcome]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    }
  }
  if (operation === 'std.bytes.decode_utf8') {
    return { kind: 'result', value: outcome }
  }
  if (operation === 'std.list.append'
    || operation === 'std.list.concat') {
    return { kind: 'list', value: outcome }
  }
  if (operation === 'std.result.is_err'
    || operation === 'std.result.is_ok') {
    return { kind: 'bool', value: outcome }
  }
  if (operation === 'std.text.concat') {
    return { kind: 'text', value: outcome }
  }
  fail('standalone-minimal-std-operation-unknown')
}

function parametersFromWitness(witness) {
  if (!plainObject(witness)
    || witness.schema !== 're.minimal-std-parameter-witness@0.1.0'
    || !Array.isArray(witness.parameters)) {
    fail('standalone-minimal-std-witness-invalid')
  }
  return Object.fromEntries(witness.parameters.map(({ name, value }) => [
    name,
    valueFromWitness(value),
  ]))
}

function valueFromWitness(value) {
  if (!plainObject(value) || typeof value.kind !== 'string') {
    fail('standalone-minimal-std-witness-invalid')
  }
  switch (value.kind) {
    case 'bytes':
      if (value.encoding !== 'hex' || typeof value.value !== 'string'
        || value.value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value.value)) {
        fail('standalone-minimal-std-witness-invalid')
      }
      return Uint8Array.from(
        value.value.match(/../gu)?.map((part) => Number.parseInt(part, 16))
          ?? [],
      )
    case 'list':
      if (!Array.isArray(value.items)) {
        fail('standalone-minimal-std-witness-invalid')
      }
      return value.items.map(valueFromWitness)
    case 'record':
      if (!Array.isArray(value.fields)) {
        fail('standalone-minimal-std-witness-invalid')
      }
      return Object.fromEntries(value.fields.map(({ name, value: child }) => [
        name,
        valueFromWitness(child),
      ]))
    case 'text':
      return value.value
    case 'bool':
      return value.value
    case 'null':
      return null
    default:
      fail('standalone-minimal-std-witness-invalid')
  }
}

function validateInputs(inputs) {
  validateAuthorityInputs(inputs)
  if (!isAbsolute(inputs.compiler_path)
    || typeof inputs.target_triple !== 'string'
    || inputs.target_triple.length === 0) {
    fail('standalone-minimal-std-input-invalid')
  }
}

function validateAuthorityInputs({ abi, bundle, corpus, package_digest }) {
  if (!plainObject(corpus)
    || corpus.schema !== 're.minimal-std-native-corpus@0.1.0'
    || !Array.isArray(corpus.cases)
    || corpus.cases.length !== 12
    || !DIGEST.test(package_digest)) {
    fail('standalone-minimal-std-input-invalid')
  }
  const verified = verifyMinimalStdNativeBundle(bundle, { abi, corpus })
  if (!verified.ok) fail(verified.diagnostics[0].code)
}

function validateRequest(request) {
  if (!plainObject(request)
    || !exactShape(request, [
      'bundle_digest',
      'invocation_digest',
      'operation',
      'operation_code',
      'oracle_receipt_digest',
      'package_digest',
      'parameter_payload_base64',
      'parameter_payload_digest',
      'parameter_witness',
      'parameter_witness_digest',
      'request_digest',
      'schema',
      'type_arguments',
      'type_arguments_digest',
      'workload_id',
    ])
    || request.schema !== STANDALONE_MINIMAL_STD_REQUEST_SCHEMA
    || !DIGEST.test(request.bundle_digest)
    || !DIGEST.test(request.invocation_digest)
    || !DIGEST.test(request.oracle_receipt_digest)
    || !DIGEST.test(request.package_digest)
    || !DIGEST.test(request.parameter_payload_digest)
    || !DIGEST.test(request.parameter_witness_digest)
    || !DIGEST.test(request.request_digest)
    || !DIGEST.test(request.type_arguments_digest)
    || typeof request.workload_id !== 'string'
    || request.workload_id.length === 0
    || typeof request.operation !== 'string'
    || request.operation_code !== OPERATION_CODES.get(request.operation)
    || !Array.isArray(request.type_arguments)
    || !canonicalEqual(request.type_arguments, TYPE_ARGUMENTS.get(
      request.operation_code,
    ))
    || request.type_arguments_digest !== digestValue(request.type_arguments)
    || !plainObject(request.parameter_witness)
    || request.parameter_witness_digest !== digestValue(
      request.parameter_witness,
    )
    || typeof request.parameter_payload_base64 !== 'string') {
    fail('standalone-minimal-std-request-invalid')
  }
  const payload = Buffer.from(request.parameter_payload_base64, 'base64')
  if (payload.toString('base64') !== request.parameter_payload_base64
    || request.parameter_payload_digest !== digestBytes(payload)
    || request.request_digest !== standaloneMinimalStdRequestDigest(request)) {
    fail('standalone-minimal-std-request-authority-mismatch')
  }
}

function validateReport(report) {
  if (!plainObject(report)
    || !exactShape(report, [
      'bundle_digest',
      'candidate',
      'executable_digest',
      'package_digest',
      'profile',
      'provenance',
      'report_digest',
      'schema',
      'source_digest',
      'status',
      'target_triple',
      'wire_schema',
      'workloads',
    ])
    || report.schema !== STANDALONE_MINIMAL_STD_REPORT_SCHEMA
    || report.profile !== STANDALONE_MINIMAL_STD_PROFILE
    || report.candidate !== 'standalone-c11'
    || report.status !== 'measured'
    || report.wire_schema !== STANDALONE_MINIMAL_STD_WIRE_SCHEMA
    || !DIGEST.test(report.bundle_digest)
    || !DIGEST.test(report.executable_digest)
    || !DIGEST.test(report.package_digest)
    || !DIGEST.test(report.report_digest)
    || !DIGEST.test(report.source_digest)
    || !Array.isArray(report.workloads)) {
    fail('standalone-minimal-std-report-invalid')
  }
}

async function compilerProvenance({ compiler_path, target_triple }) {
  let bytes
  let metadata
  try {
    bytes = await readFile(compiler_path)
    metadata = await stat(compiler_path)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('standalone-minimal-std-compiler-missing')
    throw error
  }
  if (!metadata.isFile()) fail('standalone-minimal-std-compiler-invalid')
  const version = spawnSync(compiler_path, ['--version'], {
    encoding: 'utf8',
    shell: false,
  })
  if (version.error || version.status !== 0 || version.stdout.length === 0) {
    fail('standalone-minimal-std-compiler-version-failed')
  }
  const identity = {
    architecture: arch(),
    compiler_digest: digestBytes(bytes),
    compiler_path,
    compiler_version_digest: digestBytes(Buffer.from(version.stdout, 'utf8')),
    environment_id: `${platform()}-${arch()}-standalone-minimal-std`,
    operating_system: platform(),
    target_triple,
  }
  return {
    ...identity,
    host_identity_digest: digestValue({ ...identity, release: release() }),
    measurement_source: 'runner',
    runner_id: STANDALONE_MINIMAL_STD_PROFILE,
    synthetic: false,
  }
}

function frame(magic, payload) {
  if (payload.length > MAX_PAYLOAD_BYTES) {
    fail('standalone-minimal-std-wire-payload-too-large')
  }
  const header = Buffer.alloc(HEADER_BYTES)
  magic.copy(header, 0)
  header.writeUInt32LE(payload.length, 8)
  sha256(payload).copy(header, 12)
  return Buffer.concat([header, payload])
}

function fieldBytes(value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  if (!Buffer.isBuffer(bytes) || bytes.length > 4096) {
    fail('standalone-minimal-std-wire-field-invalid')
  }
  return Buffer.concat([length16(bytes), bytes])
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
  if (value instanceof Uint8Array) {
    return `{"$bytes":${JSON.stringify(Buffer.from(value).toString('hex'))}}`
  }
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
    && Object.keys(value).sort().join('\0') === [...fields].sort().join('\0')
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
