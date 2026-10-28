import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import {
  executeMinimalStdOperation,
  minimalStdOperationContract,
} from './minimal-std-subset.js'
import { minimalStdPackageManifest } from './minimal-std-abi.js'

export const MINIMAL_STD_NATIVE_PROFILE = 're.minimal-std-native@0.1.0'
export const MINIMAL_STD_NATIVE_CORPUS_SCHEMA =
  're.minimal-std-native-corpus@0.1.0'
export const MINIMAL_STD_NATIVE_BUNDLE_SCHEMA =
  're.minimal-std-native-bundle@0.1.0'
export const MINIMAL_STD_NATIVE_REPORT_SCHEMA =
  're.minimal-std-native-report@0.1.0'
export const MINIMAL_STD_NATIVE_PACKAGE_INDEX_SCHEMA =
  're.minimal-std-native-package-index@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const BUNDLE_FIELDS = [
  'abi_report_digest',
  'bundle_digest',
  'corpus_digest',
  'profile',
  'runtime',
  'schema',
  'target_triple',
  'workloads',
]
const WORKLOAD_FIELDS = [
  'id',
  'operation',
  'receipt_digest',
  'request_digest',
  'source',
  'source_digest',
]
const REPORT_FIELDS = [
  'bundle_digest',
  'profile',
  'provenance',
  'report_digest',
  'schema',
  'status',
  'target_triple',
  'workloads',
]
const REPORT_WORKLOAD_FIELDS = [
  'executable_digest',
  'execution',
  'id',
  'operation',
  'receipt_digest',
  'request_digest',
  'source_digest',
  'stdout_digest',
  'workload_digest',
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
const NATIVE_TARGET_TRIPLES = new Set([
  'arm64-apple-darwin',
  'x86_64-unknown-linux-gnu',
])

export function createMinimalStdNativeBundle({ abi, corpus } = {}) {
  try {
    validateCorpus(corpus)
    if (!plainObject(abi)
      || abi.schema !== 're.minimal-std-abi-report@0.1.0'
      || !DIGEST.test(abi.report_digest)) {
      fail('minimal-std-native-abi-authority-invalid')
    }
    const workloads = corpus.cases.map((entry) => {
      const prepared = prepareCase(corpus, entry)
      const source = minimalStdNativeDriverCSource({
        ...prepared,
        operation: entry.operation,
        request_digest: prepared.receipt.invocation_digest,
      })
      return {
        id: entry.id,
        operation: entry.operation,
        receipt_digest: prepared.receipt.receipt_digest,
        request_digest: prepared.receipt.invocation_digest,
        source,
        source_digest: digestBytes(Buffer.from(source, 'utf8')),
      }
    })
    const bundle = {
      abi_report_digest: abi.report_digest,
      corpus_digest: digestValue(corpus),
      profile: MINIMAL_STD_NATIVE_PROFILE,
      runtime: 'native-c11',
      schema: MINIMAL_STD_NATIVE_BUNDLE_SCHEMA,
      target_triple: 'portable-c11',
      workloads,
    }
    bundle.bundle_digest = minimalStdNativeBundleDigest(bundle)
    return validateBundle(bundle)
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-bundle-build-failed')
  }
}

export function verifyMinimalStdNativeBundle(bundle, { abi, corpus } = {}) {
  try {
    validateCorpus(corpus)
    if (!plainObject(abi)
      || abi.schema !== 're.minimal-std-abi-report@0.1.0'
      || !DIGEST.test(abi.report_digest)) {
      fail('minimal-std-native-abi-authority-invalid')
    }
    validateBundle(bundle)
    if (bundle.bundle_digest !== minimalStdNativeBundleDigest(bundle)
      || bundle.abi_report_digest !== abi.report_digest
      || bundle.corpus_digest !== digestValue(corpus)) {
      fail('minimal-std-native-bundle-authority-mismatch')
    }
    const expected = createMinimalStdNativeBundle({ abi, corpus })
    if (!expected.ok) return expected
    if (!canonicalEqual(bundle, expected.value)) {
      fail('minimal-std-native-bundle-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-bundle-invalid')
  }
}

export async function runMinimalStdNativeConformance({
  abi,
  bundle,
  compiler_path,
  corpus,
  target_triple,
} = {}) {
  let root = null
  try {
    if (!isAbsolute(compiler_path) || typeof target_triple !== 'string'
      || target_triple.length === 0) {
      fail('minimal-std-native-input-invalid')
    }
    const verified = verifyMinimalStdNativeBundle(bundle, { abi, corpus })
    if (!verified.ok) return verified
    if (bundle.target_triple !== 'portable-c11'
      || !NATIVE_TARGET_TRIPLES.has(target_triple)) {
      fail('minimal-std-native-target-mismatch')
    }
    const provenance = await currentCompilerProvenance({
      compiler_path,
      target_triple,
    })
    root = await mkdtemp(join(tmpdir(), 're-minimal-std-native-'))
    const headerPath = join(root, 'minimal_std.h')
    const corePath = join(root, 'minimal_std.c')
    await writeFile(headerPath, minimalStdNativeHeaderCSource(), 'utf8')
    await writeFile(corePath, minimalStdNativeCoreCSource(), 'utf8')
    const workloads = []
    for (let index = 0; index < bundle.workloads.length; index += 1) {
      const expected = bundle.workloads[index]
      const sourcePath = join(root, `${String(index).padStart(2, '0')}.c`)
      const executablePath = join(root, `${String(index).padStart(2, '0')}.bin`)
      await writeFile(sourcePath, expected.source, 'utf8')
      const built = spawnSync(
        compiler_path,
        [
          '-O2',
          '-std=c11',
          '-target',
          target_triple,
          '-I',
          root,
          corePath,
          sourcePath,
          '-o',
          executablePath,
        ],
        { cwd: root, encoding: 'utf8', shell: false },
      )
      if (built.error?.code === 'ENOENT') {
        fail('minimal-std-native-compiler-missing')
      }
      if (built.error || built.status !== 0) {
        fail('minimal-std-native-compile-failed')
      }
      const executed = spawnSync(executablePath, [], {
        cwd: root,
        encoding: 'utf8',
        shell: false,
      })
      if (executed.error || executed.status !== 0 || executed.stderr !== '') {
        fail('minimal-std-native-execution-failed')
      }
      let execution
      try {
        execution = JSON.parse(executed.stdout)
      } catch {
        fail('minimal-std-native-output-invalid')
      }
      const prepared = prepareCase(corpus, corpus.cases[index])
      if (execution.operation !== expected.operation
        || execution.request_digest !== expected.request_digest
        || !canonicalEqual(
          execution.result,
          nativeResult(corpus.cases[index].operation, prepared.receipt.outcome),
        )) {
        fail('minimal-std-native-semantic-oracle-mismatch')
      }
      const workload = {
        executable_digest: digestBytes(await readFile(executablePath)),
        execution,
        id: expected.id,
        operation: expected.operation,
        receipt_digest: expected.receipt_digest,
        request_digest: expected.request_digest,
        source_digest: expected.source_digest,
        stdout_digest: digestBytes(Buffer.from(executed.stdout, 'utf8')),
      }
      workload.workload_digest = minimalStdNativeWorkloadDigest(workload)
      workloads.push(workload)
    }
    const report = {
      bundle_digest: bundle.bundle_digest,
      profile: MINIMAL_STD_NATIVE_PROFILE,
      provenance,
      schema: MINIMAL_STD_NATIVE_REPORT_SCHEMA,
      status: 'measured',
      target_triple,
      workloads,
    }
    report.report_digest = minimalStdNativeReportDigest(report)
    return { ok: true, value: report }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-runner-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function verifyMinimalStdNativeConformance(report, {
  abi,
  bundle,
  compiler_path,
  corpus,
  target_triple,
} = {}) {
  try {
    const authority = verifyMinimalStdNativeReportAuthority(report, {
      abi,
      bundle,
      corpus,
      target_triple,
    })
    if (!authority.ok) return authority
    const rerun = await runMinimalStdNativeConformance({
      abi,
      bundle,
      compiler_path,
      corpus,
      target_triple,
    })
    if (!rerun.ok) return rerun
    if (!canonicalEqual(report, rerun.value)) {
      fail('minimal-std-native-report-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-report-invalid')
  }
}

export function verifyMinimalStdNativeReportAuthority(report, {
  abi,
  bundle,
  corpus,
  target_triple,
} = {}) {
  try {
    validateReport(report)
    const verified = verifyMinimalStdNativeBundle(bundle, { abi, corpus })
    if (!verified.ok) return verified
    if (report.bundle_digest !== bundle.bundle_digest
      || report.target_triple !== target_triple
      || report.report_digest !== minimalStdNativeReportDigest(report)
      || report.workloads.length !== bundle.workloads.length) {
      fail('minimal-std-native-report-authority-mismatch')
    }
    for (let index = 0; index < bundle.workloads.length; index += 1) {
      const expected = bundle.workloads[index]
      const actual = report.workloads[index]
      const prepared = prepareCase(corpus, corpus.cases[index])
      const execution = {
        operation: expected.operation,
        request_digest: expected.request_digest,
        result: nativeResult(
          corpus.cases[index].operation,
          prepared.receipt.outcome,
        ),
      }
      if (actual.id !== expected.id
        || actual.operation !== expected.operation
        || actual.receipt_digest !== expected.receipt_digest
        || actual.request_digest !== expected.request_digest
        || actual.source_digest !== expected.source_digest
        || !canonicalEqual(actual.execution, execution)
        || actual.stdout_digest !== digestBytes(
          Buffer.from(`${JSON.stringify(execution)}\n`, 'utf8'),
        )
        || actual.workload_digest !== minimalStdNativeWorkloadDigest(actual)) {
        fail('minimal-std-native-report-authority-mismatch')
      }
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-report-invalid')
  }
}

export function minimalStdNativeBundleDigest(bundle) {
  const { bundle_digest: ignored, ...content } = bundle
  return digestValue(content)
}

export function minimalStdNativeWorkloadDigest(workload) {
  const { workload_digest: ignored, executable_digest: ignoredExecutable,
    stdout_digest: ignoredStdout, ...content } = workload
  return digestValue(content)
}

export function minimalStdNativeReportDigest(report) {
  const { report_digest: ignored, ...content } = report
  return digestValue(content)
}

export function minimalStdNativePackageIndex(bundle) {
  validateBundle(bundle)
  return {
    bundle_digest: bundle.bundle_digest,
    core_digest: digestBytes(
      Buffer.from(minimalStdNativeCoreCSource(), 'utf8'),
    ),
    header_digest: digestBytes(
      Buffer.from(minimalStdNativeHeaderCSource(), 'utf8'),
    ),
    profile: MINIMAL_STD_NATIVE_PROFILE,
    schema: MINIMAL_STD_NATIVE_PACKAGE_INDEX_SCHEMA,
    workloads: bundle.workloads.map((workload) => ({
      id: workload.id,
      operation: workload.operation,
      receipt_digest: workload.receipt_digest,
      request_digest: workload.request_digest,
      source_digest: workload.source_digest,
      source_path: `conformance/minimal-std/${safeName(workload.id)}.c`,
    })),
  }
}

export function minimalStdNativeHeaderCSource() {
  return [
    '#ifndef REVIA_MINIMAL_STD_H',
    '#define REVIA_MINIMAL_STD_H',
    '',
    '#include <stddef.h>',
    '',
    'typedef struct {',
    '  int operation_code;',
    '  const char *operation_json;',
    '  const char *request_digest_json;',
    '  const unsigned char *bytes_left;',
    '  size_t bytes_left_len;',
    '  const unsigned char *bytes_right;',
    '  size_t bytes_right_len;',
    '  const unsigned char *text_left;',
    '  size_t text_left_len;',
    '  const unsigned char *text_right;',
    '  size_t text_right_len;',
    '  const char *list_left_json;',
    '  size_t list_left_len;',
    '  const char *list_right_json;',
    '  size_t list_right_len;',
    '  const char *list_value_json;',
    '  int list_length;',
    '  int result_is_err;',
    '} revia_minimal_std_program;',
    '',
    'int revia_minimal_std_execute(const revia_minimal_std_program *program);',
    '',
    '#endif',
    '',
  ].join('\n')
}

export function minimalStdNativeCoreCSource() {
  return [
    '#include "minimal_std.h"',
    '',
    '#include <stdio.h>',
    '',
    'static void emit_json_escaped(const unsigned char *bytes, size_t length) {',
    '  for (size_t index = 0; index < length; index += 1) {',
    '    unsigned char byte = bytes[index];',
    '    if (byte == 34 || byte == 92) { putchar(92); putchar(byte); }',
    '    else if (byte == 8) printf("\\\\b");',
    '    else if (byte == 12) printf("\\\\f");',
    '    else if (byte == 10) printf("\\\\n");',
    '    else if (byte == 13) printf("\\\\r");',
    '    else if (byte == 9) printf("\\\\t");',
    '    else if (byte < 32) printf("\\\\u%04x", byte);',
    '    else putchar(byte);',
    '  }',
    '}',
    '',
    'static void emit_json_string(const unsigned char *bytes, size_t length) {',
    '  putchar(34);',
    '  emit_json_escaped(bytes, length);',
    '  putchar(34);',
    '}',
    '',
    'static void emit_hex(const unsigned char *bytes, size_t length) {',
    '  static const char HEX[] = "0123456789abcdef";',
    '  for (size_t index = 0; index < length; index += 1) {',
    '    putchar(HEX[bytes[index] >> 4]);',
    '    putchar(HEX[bytes[index] & 15]);',
    '  }',
    '}',
    '',
    'static int utf8(const unsigned char *bytes, size_t length, size_t *count) {',
    '  size_t index = 0;',
    '  size_t scalars = 0;',
    '  while (index < length) {',
    '    unsigned char byte = bytes[index];',
    '    size_t width = 0;',
    '    unsigned int code = 0;',
    '    if (byte <= 0x7f) { width = 1; code = byte; }',
    '    else if (byte >= 0xc2 && byte <= 0xdf) { width = 2; code = byte & 31; }',
    '    else if (byte >= 0xe0 && byte <= 0xef) { width = 3; code = byte & 15; }',
    '    else if (byte >= 0xf0 && byte <= 0xf4) { width = 4; code = byte & 7; }',
    '    else return 0;',
    '    if (index + width > length) return 0;',
    '    for (size_t offset = 1; offset < width; offset += 1) {',
    '      unsigned char continuation = bytes[index + offset];',
    '      if ((continuation & 0xc0) != 0x80) return 0;',
    '      code = (code << 6) | (continuation & 63);',
    '    }',
    '    if ((width == 2 && code < 0x80)',
    '        || (width == 3 && code < 0x800)',
    '        || (width == 4 && code < 0x10000)',
    '        || code > 0x10ffff',
    '        || (code >= 0xd800 && code <= 0xdfff)) return 0;',
    '    index += width;',
    '    scalars += 1;',
    '  }',
    '  if (count != NULL) *count = scalars;',
    '  return 1;',
    '}',
    '',
    'static void begin(const revia_minimal_std_program *program) {',
    '  printf("{\\"operation\\":%s,\\"request_digest\\":%s,\\"result\\":",',
    '    program->operation_json, program->request_digest_json);',
    '}',
    '',
    'int revia_minimal_std_execute(const revia_minimal_std_program *program) {',
    '  if (program == NULL) return 72;',
    '  begin(program);',
    '  switch (program->operation_code) {',
    '    case 1:',
    '      printf("{\\"kind\\":\\"int\\",\\"value\\":\\"%zu\\"}", program->bytes_left_len);',
    '      break;',
    '    case 2:',
    '      printf("{\\"kind\\":\\"bytes\\",\\"value\\":\\"");',
    '      emit_hex(program->bytes_left, program->bytes_left_len);',
    '      emit_hex(program->bytes_right, program->bytes_right_len);',
    '      printf("\\"}");',
    '      break;',
    '    case 3: {',
    '      size_t count = 0;',
    '      if (!utf8(program->bytes_left, program->bytes_left_len, &count)) {',
    '        printf("{\\"kind\\":\\"result\\",\\"value\\":{\\"error\\":{\\"type\\":\\"std.bytes.decode_error\\",\\"variant\\":\\"invalid_utf8\\"},\\"kind\\":\\"err\\"}}");',
    '      } else {',
    '        printf("{\\"kind\\":\\"result\\",\\"value\\":{\\"kind\\":\\"ok\\",\\"value\\":");',
    '        emit_json_string(program->bytes_left, program->bytes_left_len);',
    '        printf("}}");',
    '      }',
    '      break;',
    '    }',
    '    case 4:',
    '      printf("{\\"kind\\":\\"list\\",\\"value\\":[%s%s%s]}",',
    '        program->list_left_json,',
    '        program->list_length > 0 ? "," : "",',
    '        program->list_value_json);',
    '      break;',
    '    case 5:',
    '      printf("{\\"kind\\":\\"list\\",\\"value\\":[%s%s%s]}",',
    '        program->list_left_json,',
    '        (program->list_length > 0 && program->list_right_len > 0) ? "," : "",',
    '        program->list_right_json);',
    '      break;',
    '    case 6:',
    '      printf("{\\"kind\\":\\"int\\",\\"value\\":\\"%d\\"}", program->list_length);',
    '      break;',
    '    case 7:',
    '      printf("{\\"kind\\":\\"bool\\",\\"value\\":%s}", program->result_is_err ? "true" : "false");',
    '      break;',
    '    case 8:',
    '      printf("{\\"kind\\":\\"bool\\",\\"value\\":%s}", program->result_is_err ? "false" : "true");',
    '      break;',
    '    case 9:',
    '      printf("{\\"kind\\":\\"text\\",\\"value\\":");',
    '      putchar(34);',
    '      emit_json_escaped(program->text_left, program->text_left_len);',
    '      emit_json_escaped(program->text_right, program->text_right_len);',
    '      putchar(34);',
    '      putchar(125);',
    '      break;',
    '    case 10:',
    '      printf("{\\"kind\\":\\"bytes\\",\\"value\\":\\"");',
    '      emit_hex(program->text_left, program->text_left_len);',
    '      printf("\\"}");',
    '      break;',
    '    case 11: {',
    '      size_t count = 0;',
    '      if (!utf8(program->text_left, program->text_left_len, &count)) return 74;',
    '      printf("{\\"kind\\":\\"int\\",\\"value\\":\\"%zu\\"}", count);',
    '      break;',
    '    }',
    '    default:',
    '      return 71;',
    '  }',
    '  putchar(125);',
    '  putchar(10);',
    '  return 0;',
    '}',
    '',
  ].join('\n')
}

export function minimalStdNativeDriverCSource({
  operation,
  request_digest,
  parameters,
} = {}) {
  const code = OPERATION_CODES.get(operation)
  if (code === undefined) throw coded('minimal-std-native-operation-unknown')
  const bytesLeft = firstBytes(parameters, ['value', 'left'])
  const bytesRight = parameters?.right instanceof Uint8Array
    ? parameters.right
    : new Uint8Array()
  const textLeft = firstText(parameters, ['value', 'left'])
  const textRight = parameters?.right ?? ''
  const listLeft = parameters?.values ?? parameters?.left ?? []
  const listRight = parameters?.right ?? []
  const listValue = parameters?.value
  const resultIsErr = parameters?.value?.kind === 'err' ? 1 : 0
  const listLeftItems = Array.isArray(listLeft) ? listLeft : []
  const listRightItems = Array.isArray(listRight) ? listRight : []
  const listLeftJson = listLeftItems.map(jsonValue).join(',')
  const listRightJson = listRightItems.map(jsonValue).join(',')
  const listValueJson = jsonValue(listValue)
  const textLeftBytes = new TextEncoder().encode(textLeft)
  const textRightBytes = new TextEncoder().encode(String(textRight))
  const fields = [
    ['operation_code', code],
    ['operation_json', cString(JSON.stringify(operation))],
    ['request_digest_json', cString(JSON.stringify(request_digest))],
    ['bytes_left', bytesLeft.length === 0 ? 'NULL' : 'bytes_left'],
    ['bytes_left_len', bytesLeft.length],
    ['bytes_right', bytesRight.length === 0 ? 'NULL' : 'bytes_right'],
    ['bytes_right_len', bytesRight.length],
    ['text_left', textLeftBytes.length === 0 ? 'NULL' : 'text_left'],
    ['text_left_len', textLeftBytes.length],
    ['text_right', textRightBytes.length === 0 ? 'NULL' : 'text_right'],
    ['text_right_len', textRightBytes.length],
    ['list_left_json', 'list_left_json'],
    ['list_left_len', listLeftItems.length],
    ['list_right_json', 'list_right_json'],
    ['list_right_len', listRightItems.length],
    ['list_value_json', 'list_value_json'],
    ['list_length', listLeftItems.length],
    ['result_is_err', resultIsErr],
  ]
  return [
    '#include "minimal_std.h"',
    '',
    ...cArrayDeclaration('bytes_left', bytesLeft),
    ...cArrayDeclaration('bytes_right', bytesRight),
    ...cArrayDeclaration('text_left', textLeftBytes),
    ...cArrayDeclaration('text_right', textRightBytes),
    `static const char list_left_json[] = ${cString(listLeftJson)};`,
    `static const char list_right_json[] = ${cString(listRightJson)};`,
    `static const char list_value_json[] = ${cString(listValueJson)};`,
    '',
    'int main(void) {',
    '  static const revia_minimal_std_program program = {',
    ...fields.map(([field, value]) => (
      `    .${field} = ${typeof value === 'number' ? value : value},`
    )),
    '  };',
    '  return revia_minimal_std_execute(&program);',
    '}',
    '',
  ].join('\n')
}

function prepareCase(corpus, entry) {
  const parameters = parametersFromWitness(entry.parameter_witness)
  const receipt = executeMinimalStdOperation({
    graph_revision: corpus.graph_revision,
    operation: entry.operation,
    package_manifest: minimalStdPackageManifest(),
    parameters,
    schema: 're.minimal-std-invocation@0.1.0',
    type_arguments: entry.type_arguments,
  })
  if (!receipt.ok) fail(receipt.diagnostics[0].code)
  return { parameters, receipt: receipt.value }
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
  fail('minimal-std-native-operation-unknown')
}

function validateCorpus(corpus) {
  if (!plainObject(corpus)
    || corpus.schema !== MINIMAL_STD_NATIVE_CORPUS_SCHEMA
    || !DIGEST.test(corpus.graph_revision)
    || !Array.isArray(corpus.cases)
    || corpus.cases.length !== 12) {
    fail('minimal-std-native-corpus-invalid')
  }
  const ids = new Set()
  for (const entry of corpus.cases) {
    if (!plainObject(entry)
      || typeof entry.id !== 'string'
      || ids.has(entry.id)
      || typeof entry.operation !== 'string'
      || !OPERATION_CODES.has(entry.operation)
      || !Array.isArray(entry.type_arguments)
      || !plainObject(entry.parameter_witness)) {
      fail('minimal-std-native-corpus-invalid')
    }
    ids.add(entry.id)
    if (minimalStdOperationContract(entry.operation) === null) {
      fail('minimal-std-native-corpus-operation-invalid')
    }
  }
}

function validateBundle(bundle) {
  if (!plainObject(bundle)
    || !exactShape(bundle, BUNDLE_FIELDS)
    || bundle.schema !== MINIMAL_STD_NATIVE_BUNDLE_SCHEMA
    || bundle.profile !== MINIMAL_STD_NATIVE_PROFILE
    || bundle.runtime !== 'native-c11'
    || !DIGEST.test(bundle.abi_report_digest)
    || !DIGEST.test(bundle.bundle_digest)
    || !DIGEST.test(bundle.corpus_digest)
    || bundle.target_triple !== 'portable-c11'
    || !Array.isArray(bundle.workloads)
    || bundle.workloads.length !== 12
    || bundle.bundle_digest !== minimalStdNativeBundleDigest(bundle)) {
    fail('minimal-std-native-bundle-invalid')
  }
  for (const workload of bundle.workloads) {
    if (!plainObject(workload)
      || !exactShape(workload, WORKLOAD_FIELDS)
      || typeof workload.id !== 'string'
      || typeof workload.operation !== 'string'
      || !DIGEST.test(workload.receipt_digest)
      || !DIGEST.test(workload.request_digest)
      || typeof workload.source !== 'string'
      || !DIGEST.test(workload.source_digest)
      || workload.source_digest !== digestBytes(Buffer.from(workload.source, 'utf8'))) {
      fail('minimal-std-native-bundle-workload-invalid')
    }
  }
  return { ok: true, value: bundle }
}

function validateReport(report) {
  if (!plainObject(report)
    || !exactShape(report, REPORT_FIELDS)
    || report.schema !== MINIMAL_STD_NATIVE_REPORT_SCHEMA
    || report.profile !== MINIMAL_STD_NATIVE_PROFILE
    || report.status !== 'measured'
    || !DIGEST.test(report.bundle_digest)
    || !DIGEST.test(report.report_digest)
    || typeof report.target_triple !== 'string'
    || !Array.isArray(report.workloads)) {
    fail('minimal-std-native-report-invalid')
  }
  validateProvenance(report.provenance)
  for (const workload of report.workloads) {
    if (!plainObject(workload)
      || !exactShape(workload, REPORT_WORKLOAD_FIELDS)
      || typeof workload.id !== 'string'
      || typeof workload.operation !== 'string'
      || !DIGEST.test(workload.executable_digest)
      || !plainObject(workload.execution)
      || !DIGEST.test(workload.receipt_digest)
      || !DIGEST.test(workload.request_digest)
      || !DIGEST.test(workload.source_digest)
      || !DIGEST.test(workload.stdout_digest)
      || !DIGEST.test(workload.workload_digest)
      || workload.workload_digest !== minimalStdNativeWorkloadDigest(workload)) {
      fail('minimal-std-native-report-workload-invalid')
    }
  }
}

async function currentCompilerProvenance({ compiler_path, target_triple }) {
  let compilerBytes
  let metadata
  try {
    compilerBytes = await readFile(compiler_path)
    metadata = await stat(compiler_path)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('minimal-std-native-compiler-missing')
    throw error
  }
  if (!metadata.isFile()) fail('minimal-std-native-compiler-invalid')
  const version = spawnSync(compiler_path, ['--version'], {
    encoding: 'utf8',
    shell: false,
  })
  if (version.error || version.status !== 0 || version.stdout.length === 0) {
    fail('minimal-std-native-compiler-version-failed')
  }
  return {
    architecture: process.arch,
    compiler_digest: digestBytes(compilerBytes),
    compiler_path,
    compiler_version_digest: digestBytes(Buffer.from(version.stdout, 'utf8')),
    environment_id: `re-minimal-std-native-${process.platform}-${process.arch}`,
    host_identity_digest: digestValue({
      arch: process.arch,
      platform: process.platform,
      release: process.release,
    }),
    measurement_source: 'runner',
    operating_system: process.platform,
    runner_id: MINIMAL_STD_NATIVE_PROFILE,
    synthetic: false,
    target_triple,
  }
}

function validateProvenance(provenance) {
  if (!plainObject(provenance)
    || !exactShape(provenance, PROVENANCE_FIELDS)
    || !['darwin', 'linux', 'win32'].includes(provenance.operating_system)
    || typeof provenance.architecture !== 'string'
    || !DIGEST.test(provenance.compiler_digest)
    || !isAbsolute(provenance.compiler_path)
    || !DIGEST.test(provenance.compiler_version_digest)
    || typeof provenance.environment_id !== 'string'
    || !DIGEST.test(provenance.host_identity_digest)
    || provenance.measurement_source !== 'runner'
    || typeof provenance.runner_id !== 'string'
    || provenance.synthetic !== false
    || typeof provenance.target_triple !== 'string') {
    fail('minimal-std-native-provenance-invalid')
  }
}

function parametersFromWitness(witness) {
  if (!plainObject(witness)
    || witness.schema !== 're.minimal-std-parameter-witness@0.1.0'
    || !Array.isArray(witness.parameters)) {
    fail('minimal-std-native-witness-invalid')
  }
  return Object.fromEntries(witness.parameters.map(({ name, value }) => [
    name,
    valueFromWitness(value),
  ]))
}

function valueFromWitness(value) {
  if (!plainObject(value) || typeof value.kind !== 'string') {
    fail('minimal-std-native-witness-invalid')
  }
  switch (value.kind) {
    case 'bytes':
      if (value.encoding !== 'hex' || typeof value.value !== 'string'
        || value.value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value.value)) {
        fail('minimal-std-native-witness-invalid')
      }
      return Uint8Array.from(
        value.value.match(/../gu)?.map((part) => Number.parseInt(part, 16))
          ?? [],
      )
    case 'list':
      return value.items.map(valueFromWitness)
    case 'record':
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
      fail('minimal-std-native-witness-invalid')
  }
}

function firstBytes(parameters, names) {
  for (const name of names) {
    if (parameters?.[name] instanceof Uint8Array) return parameters[name]
  }
  return new Uint8Array()
}

function firstText(parameters, names) {
  for (const name of names) {
    if (typeof parameters?.[name] === 'string') return parameters[name]
  }
  return ''
}

function cArrayDeclaration(name, bytes) {
  if (bytes.length === 0) return []
  const values = [...bytes].map((byte) => `0x${byte.toString(16).padStart(2, '0')}`)
  return [`static const unsigned char ${name}[] = {${values.join(', ')}};`, '']
}

function cString(value) {
  return `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replace(/\n/gu, '\\n')
    .replace(/\r/gu, '\\r')
    .replace(/\t/gu, '\\t')
    .replace(/\0/gu, '\\0')}"`
}

function safeName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/gu, '_')
}

function jsonValue(value) {
  if (value instanceof Uint8Array) {
    return JSON.stringify({
      bytes: [...value].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      encoding: 'hex',
    })
  }
  if (Array.isArray(value)) return `[${value.map(jsonValue).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${jsonValue(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function coded(code) {
  return Object.assign(new TypeError(code), { code })
}

function fail(code) {
  throw coded(code)
}

function rejected(code) {
  return {
    ok: false,
    diagnostics: [{ code: typeof code === 'string' ? code : code?.code }],
  }
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function digestValue(value) {
  return digestBytes(Buffer.from(jsonValue(value), 'utf8'))
}

function canonicalEqual(left, right) {
  return jsonValue(left) === jsonValue(right)
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
