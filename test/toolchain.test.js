import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  buildSource,
  checkSource,
  profileSource,
  reviewIndexSource,
  runSource,
  viewSource,
} from '../src/toolchain/demo-toolchain.js'
import { backendMatrixDigest } from '../src/runtime/backend-contract.js'
import { EXECUTABLE_GRAMMAR_PROFILE } from '../src/toolchain/executable-grammar-profile.js'
import { parseProgram } from '../src/toolchain/parser.js'

const hello = await readFile(new URL('../examples/hello.re', import.meta.url), 'utf8')
const canonicalHello = await readFile(
  new URL('../test/golden/canonical-hello.re', import.meta.url),
  'utf8',
)
const argsCheck = await readFile(
  new URL('../examples/args-check.re', import.meta.url),
  'utf8',
)
const readCheck = await readFile(
  new URL('../examples/read-check.re', import.meta.url),
  'utf8',
)
const readEncoding = await readFile(
  new URL('../examples/read-encoding.re', import.meta.url),
  'utf8',
)
const writeCheck = await readFile(
  new URL('../examples/write-check.re', import.meta.url),
  'utf8',
)

test('toolchain fails closed on header errors before parsing a body', () => {
  const body = hello.slice(hello.indexOf('unit @hello'))
  const cases = [
    ['// prelude\nre 0.1 compact\n' + body, 'missing-grammar-header'],
    ['\nre 0.1 compact\n' + body, 'missing-grammar-header'],
    ['re 0.2 compact\n' + body, 'unsupported-language-version'],
    ['re 0.1 canonical\n' + body, 'invalid-capability-line'],
  ]

  for (const [source, code] of cases) {
    const result = checkSource(source, { file: 'dispatch.re' })
    assert.equal(result.ok, false)
    assert.equal(result.diagnostics[0].code, code)
    assert.equal(result.diagnostics[0].file, 'dispatch.re')
  }
})

test('production compact parser enforces the shared V1 source boundaries', () => {
  const annotated = hello.replace('fn @main', '#[audit.trace]\nfn @main')
  const annotationDiagnostic =
    checkSource(annotated, { file: 'annotation.re' }).diagnostics[0]
  assert.deepEqual(projectSourceDiagnostic(annotationDiagnostic), {
    actual: '#[',
    code: 'unsupported-v1-annotation',
    column: 1,
    expected: 'annotations are deferred beyond V1',
    file: 'annotation.re',
    line: 8,
  })
  assertSourceDiagnostic(annotationDiagnostic, annotated, {
    lexeme: '#[',
    phase: 'lex',
    repair: { action: 'remove' },
    rule: 'compact.annotation',
  })

  for (const [character, actual] of [
    ['\r', 'U+000D'],
    ['\u00a0', 'U+00A0'],
    ['\u2028', 'U+2028'],
  ]) {
    const source = hello.replace(
      'unit @hello\n',
      `unit @hello${character}\n`,
    )
    const result = checkSource(source, { file: 'trivia.re' })
    assert.equal(result.ok, false)
    assert.deepEqual(projectSourceDiagnostic(result.diagnostics[0]), {
      actual,
      code: 'non-ascii-compact-trivia',
      column: 12,
      expected: 'ASCII space, tab, or LF',
      file: 'trivia.re',
      line: 4,
    })
    assertSourceDiagnostic(result.diagnostics[0], source, {
      lexeme: character,
      phase: 'lex',
      rule: 'compact.trivia',
    })
  }

  const plain = parseProgram(hello, { file: 'hello.re' })
  const commented = parseProgram(
    hello.replace('unit @hello', 'unit @hello // discarded'),
    { file: 'hello.re' },
  )
  assert.equal(plain.ok, true)
  assert.equal(commented.ok, true)
  assert.deepEqual(commented.value, plain.value)
})

test('toolchain evaluates source values instead of hard-coding Hello World', () => {
  const source = hello.replace('Hello, World!', 'RE is running')

  const result = runSource(source, { file: 'changed.re' })

  assert.deepEqual(result, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: 'RE is running\n',
  })
})

test('production source can invoke the frozen zero-argument process args capability', () => {
  const success = runSource(argsCheck, {
    argv: ['alpha', 'β'],
    file: 'args-check.re',
  })
  const invalidUtf8 = runSource(argsCheck, {
    argv: [Uint8Array.from([0xc0, 0x80])],
    file: 'args-check.re',
  })

  assert.deepEqual(success, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: '',
  })
  assert.deepEqual(invalidUtf8, {
    outcome: { kind: 'process-status', status: { code: 2 } },
    programStdout: '',
  })
})

test('process args remains zero-argument and rejects invented inputs', () => {
  const source = argsCheck.replace('@args.read()', '@args.read("extra")')
  const checked = checkSource(source, { file: 'args-extra.re' })

  assert.equal(checked.ok, false)
  assert.deepEqual(checked.diagnostics[0], {
    actual: '<positional>',
    code: 'unexpected-argument',
    column: 27,
    expected: [],
    file: 'args-extra.re',
    line: 9,
    member: 'read',
    reference: 'process.args@0.1.0',
  })
})

test('production source can invoke the frozen fs read capability', () => {
  const success = runSource(readCheck, {
    file: 'read-check.re',
    host: {
      files: new Map([[
        'input.txt',
        {
          bytes: new TextEncoder().encode('hello'),
          readable: true,
          writable: true,
        },
      ]]),
    },
  })
  const missing = runSource(readCheck, { file: 'read-check.re' })
  const outside = runSource(
    readCheck.replace('"input.txt"', '"../outside.txt"'),
    { file: 'read-outside.re' },
  )

  assert.deepEqual(success, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: '',
  })
  assert.deepEqual(missing, {
    outcome: { kind: 'process-status', status: { code: 2 } },
    programStdout: '',
  })
  assert.deepEqual(outside, {
    outcome: { kind: 'process-status', status: { code: 2 } },
    programStdout: '',
  })
})

test('fs read path accepts its schema name and does not infer a missing path', () => {
  const named = checkSource(
    readCheck.replace(
      '@input.read_file("input.txt")',
      '@input.read_file(path: "input.txt")',
    ),
    { file: 'read-named.re' },
  )
  const missing = checkSource(
    readCheck.replace(
      '@input.read_file("input.txt")',
      '@input.read_file(encoding: "utf-8")',
    ),
    { file: 'read-missing-path.re' },
  )

  assert.equal(named.ok, true)
  assert.equal(missing.ok, false)
  assert.equal(missing.diagnostics[0].code, 'missing-argument')
  assert.equal(missing.diagnostics[0].parameter, 'path')
  assert.equal(missing.diagnostics[0].reference, 'fs.read@0.1.0')
})

test('fs read accepts explicit frozen UTF-8 encoding with two named arguments', () => {
  const result = runSource(readEncoding, {
    file: 'read-encoding.re',
    host: {
      files: new Map([[
        'input.txt',
        {
          bytes: new TextEncoder().encode('hello'),
          readable: true,
          writable: true,
        },
      ]]),
    },
  })

  assert.deepEqual(result, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: '',
  })
})

test('fs read multi-argument syntax rejects unknown encoding and trailing comma', () => {
  for (const [source, code] of [
    [
      readEncoding.replace('text.encoding.utf8', 'text.encoding.latin1'),
      'unsupported-text-encoding',
    ],
    [
      readEncoding.replace(
        'encoding: text.encoding.utf8)',
        'encoding: text.encoding.utf8,)',
      ),
      'unexpected-token',
    ],
  ]) {
    const checked = checkSource(source, { file: 'read-encoding-invalid.re' })
    assert.equal(checked.ok, false)
    assert.equal(checked.diagnostics[0].code, code)
  }
})

test('production source can write an exact bytes literal through fs.write', () => {
  const files = new Map()
  const result = runSource(writeCheck, {
    file: 'write-check.re',
    host: { files },
  })

  assert.deepEqual(result, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: '',
  })
  assert.deepEqual(files.get('output.txt').bytes, Uint8Array.from([
    0x41, 0x00, 0x42,
  ]))

  const outsideFiles = new Map()
  const outside = runSource(
    writeCheck.replace('"output.txt"', '"../output.txt"'),
    { file: 'write-outside.re', host: { files: outsideFiles } },
  )
  assert.deepEqual(outside, {
    outcome: { kind: 'process-status', status: { code: 2 } },
    programStdout: '',
  })
  assert.equal(outsideFiles.size, 0)
})

test('fs.write rejects malformed bytes source values', () => {
  for (const value of [
    'hex:41004',
    'hex:41004G',
    'hex:41004A',
    '410042',
  ]) {
    const checked = checkSource(
      writeCheck.replace('hex:410042', value),
      { file: 'write-invalid.re' },
    )

    assert.equal(checked.ok, false, value)
    assert.equal(checked.diagnostics[0].code, 'invalid-bytes-literal', value)
    assert.equal(checked.diagnostics[0].phase, 'parse', value)
    assert.equal(checked.diagnostics[0].rule, 'compact.bytes-literal', value)
  }
})

test('hex-tagged strings are ordinary text outside exact fs.write data', () => {
  const source = hello.replace('Hello, World!', 'hex:410042')
  const result = runSource(source, { file: 'hex-text.re' })

  assert.deepEqual(result, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: 'hex:410042\n',
  })
})

test('compact string values are NFC before execution and canonicalization', () => {
  const source = hello.replace('Hello, World!', 'cafe\u0301')

  const result = runSource(source, { file: 'nfc.re' })

  assert.deepEqual(result, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: 'caf\u00e9\n',
  })
})

test('arbitrary precision integers reach the exact operation range checker', () => {
  for (const token of ['9007199254740992', '-1']) {
    const source = hello.replace('process.exit(0)', `process.exit(${token})`)
    const result = checkSource(source, { file: 'int-range.re' })

    assert.equal(result.ok, false, token)
    assert.deepEqual(result.diagnostics[0], {
      actual: token,
      code: 'process-exit-code-out-of-range',
      column: 27,
      expected: '0..255',
      file: 'int-range.re',
      line: 11,
      type: 'process.exit_code',
    })
  }
})

test('production parser shares V1 numeric token diagnostics', () => {
  for (const [token, reason] of [
    ['+1', 'leading-plus'],
    ['01', 'leading-zero'],
    ['-0', 'negative-zero'],
    ['-0.0', 'negative-zero'],
    ['1e3', 'exponent'],
    ['1_000', 'digit-separator'],
    ['1.', 'decimal-shape'],
    ['.5', 'decimal-shape'],
  ]) {
    const source = hello.replace('process.exit(0)', `process.exit(${token})`)

    const result = checkSource(source, { file: `${reason}.re` })

    assert.equal(result.ok, false, token)
    assert.deepEqual(projectSourceDiagnostic(result.diagnostics[0]), {
      actual: token,
      code: 'invalid-numeric-literal',
      column: 27,
      expected: 'canonical int or fixed-scale decimal',
      file: `${reason}.re`,
      line: 11,
    })
    assert.equal(result.diagnostics[0].reason, reason, token)
    assertSourceDiagnostic(result.diagnostics[0], source, {
      lexeme: token,
      phase: 'parse',
      repair: {
        action: 'replace',
        expected: 'canonical int or fixed-scale decimal',
      },
      rule: 'compact.numeric-literal',
    })
  }
})

test('production decimal reaches the exact operation type checker', () => {
  const token = '9007199254740993.00100'
  const source = hello.replace('process.exit(0)', `process.exit(${token})`)

  const result = checkSource(source, { file: 'decimal-type.re' })

  assert.equal(result.ok, false)
  assert.deepEqual(result.diagnostics[0], {
    actual: 'decimal<5>',
    code: 'argument-type-mismatch',
    column: 27,
    expected: 'process.exit_code',
    file: 'decimal-type.re',
    line: 11,
    member: 'process.exit',
    parameter: 'code',
    reference: 'process.exit@0.1.0',
  })
})

test('production parser rejects decimal scale above the V1 bound', () => {
  const token = `1.${'0'.repeat(256)}`
  const source = hello.replace('process.exit(0)', `process.exit(${token})`)

  const result = checkSource(source, { file: 'decimal-scale.re' })

  assert.equal(result.ok, false)
  assert.deepEqual(projectSourceDiagnostic(result.diagnostics[0]), {
    actual: token,
    code: 'decimal-scale-out-of-range',
    column: 27,
    expected: 'decimal scale 1..255',
    file: 'decimal-scale.re',
    line: 11,
  })
  assert.equal(result.diagnostics[0].scale, 256)
  assertSourceDiagnostic(result.diagnostics[0], source, {
    lexeme: token,
    phase: 'parse',
    repair: {
      action: 'replace',
      expected: 'decimal scale 1..255',
    },
    rule: 'compact.decimal-literal',
  })
})

test('production parser never reinterprets canonical labels as compact aliases', () => {
  const source = hello.replace('%printed =', '%uabcdefg =')
  const result = checkSource(source, { file: 'canonical-label.re' })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'reserved-canonical-label')
  assertSourceDiagnostic(result.diagnostics[0], source, {
    lexeme: '%uabcdefg',
    phase: 'parse',
    repair: {
      action: 'replace',
      expected: 'compact alias not starting with %u',
    },
    rule: 'compact.alias',
  })
})

test('evaluator consumes the declared stdout error through the err branch', () => {
  const result = runSource(hello, {
    file: 'hello.re',
    host: { stdoutBroken: true },
  })

  assert.deepEqual(result, {
    outcome: { kind: 'process-status', status: { code: 1 } },
    programStdout: '',
  })
})

test('match semantics do not depend on ok and err arm source order', () => {
  const source = hello.replace(
    '    ok(_) => process.exit(0)\n    err(_) => process.exit(1)',
    '    err(_) => process.exit(1)\n    ok(_) => process.exit(0)',
  )

  const success = runSource(source, { file: 'reordered-match.re' })
  const failure = runSource(source, {
    file: 'reordered-match.re',
    host: { stdoutBroken: true },
  })

  assert.deepEqual(success, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: 'Hello, World!\n',
  })
  assert.deepEqual(failure, {
    outcome: { kind: 'process-status', status: { code: 1 } },
    programStdout: '',
  })
})

test('value edges, not statement order, determine execution dependencies', () => {
  const source = hello.replace(
    '  %printed = @stdout.write("Hello, World!\\n")\n' +
      '  return match %printed {\n' +
      '    ok(_) => process.exit(0)\n' +
      '    err(_) => process.exit(1)\n' +
      '  }',
    '  return match %printed {\n' +
      '    ok(_) => process.exit(0)\n' +
      '    err(_) => process.exit(1)\n' +
      '  }\n' +
      '  %printed = @stdout.write("Hello, World!\\n")',
  )

  const result = runSource(source, { file: 'reordered-statements.re' })

  assert.deepEqual(result, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: 'Hello, World!\n',
  })
})

test('checker reports an unknown value edge at its reference', () => {
  const source = hello.replace('match %printed', 'match %missing')

  const result = checkSource(source, { file: 'unknown-value.re' })

  assert.equal(result.ok, false)
  assert.deepEqual(result.diagnostics[0], {
    code: 'unknown-value-reference',
    column: 16,
    file: 'unknown-value.re',
    line: 10,
    reference: '%missing',
  })
})

test('checker emits pinned calls and explicit producer edges', () => {
  const result = checkSource(hello, { file: 'hello.re' })

  assert.equal(result.ok, true)
  assert.equal(result.program.kind, 'checked-program-graph')
  const main = result.program.functions.find(
    (candidate) => candidate.name === '@main',
  )
  const producer = main.statements.find((statement) => statement.kind === 'let')
  const returned = main.statements.find(
    (statement) => statement.kind === 'return',
  )
  assert.deepEqual(producer.value.target, {
    instance: '@stdout',
    kind: 'capability-member',
    member: 'write',
    schemaReference: 'process.stdout@0.1.0',
  })
  assert.equal(producer.value.returnType, 'result<unit, io.write_error>')
  assert.equal(returned.value.input.kind, 'value-edge')
  assert.equal(returned.value.input.producer, producer.uid)
})

test('semantic view IR binds facts to evidence and graph revision', () => {
  const result = viewSource(hello, { file: 'hello.re' })

  assert.equal(result.ok, true)
  assert.equal(result.value.semanticView.schema, 're.semantic-view-ir@0.1.0')
  assert.equal(result.value.semanticView.locale, 'zh-CN')
  assert.match(result.value.semanticView.revision, /^sha256:[0-9a-f]{64}$/)
  assert.equal(result.value.semanticView.unit, '@hello')
  const capability = result.value.semanticView.facts.find(
    (fact) => fact.kind === 'capability',
  )
  const effect = result.value.semanticView.facts.find(
    (fact) => fact.kind === 'effect',
  )
  const errorPath = result.value.semanticView.facts.find(
    (fact) => fact.kind === 'error_path',
  )
  assert.equal(capability.audit_category, 'capability')
  assert.equal(capability.fact_id, 'capability:@stdout')
  assert.equal(capability.reference, 'process.stdout@0.1.0')
  assert.equal(capability.revision, result.value.semanticView.revision)
  assert.equal(effect.audit_category, 'effect')
  assert.equal(effect.capability_instance, '@stdout')
  assert.deepEqual(effect.access, ['write process.stdout'])
  assert.equal(errorPath.audit_category, 'error_path')
  assert.equal(errorPath.error_type, 'io.write_error')
  assert.ok(result.value.text.includes('RE 语义视图 0.1\n单位：@hello\n'))
})

test('semantic view locale renderers share the same fact identity', () => {
  const chinese = viewSource(canonicalHello, {
    file: 'canonical-hello.re',
    locale: 'zh-CN',
  })
  const english = viewSource(canonicalHello, {
    file: 'canonical-hello.re',
    locale: 'en-US',
  })

  assert.equal(chinese.ok, true)
  assert.equal(english.ok, true)
  assert.equal(chinese.value.semanticView.revision, english.value.semanticView.revision)
  assert.deepEqual(
    chinese.value.semanticView.facts.map(({ fact_id }) => fact_id),
    english.value.semanticView.facts.map(({ fact_id }) => fact_id),
  )
  assert.equal(chinese.value.semanticView.locale, 'zh-CN')
  assert.equal(english.value.semanticView.locale, 'en-US')
  assert.ok(chinese.value.text.includes('能力：\n'))
  assert.ok(english.value.text.includes('Capabilities:\n'))
})

test('semantic view HTML is generated from the same revision-pinned facts', () => {
  const result = viewSource(canonicalHello, {
    file: 'canonical-hello.re',
    format: 'html',
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.semanticView.schema, 're.semantic-view-ir@0.1.0')
  assert.equal(result.value.semanticView.revision, 'sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083')
  assert.match(result.value.html, /^<!doctype html>\n<html lang="zh-CN">/)
  assert.match(result.value.html, /<main data-schema="re.semantic-view-ir@0.1.0"/)
  assert.match(result.value.html, /<code>capability:@stdout<\/code>/)
  assert.match(result.value.html, /<code>status-codes<\/code>/)
  assert.equal(result.value.text, undefined)
})

test('semantic view SVG is generated from the same revision-pinned facts', () => {
  const result = viewSource(canonicalHello, {
    file: 'canonical-hello.re',
    format: 'svg',
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.semanticView.schema, 're.semantic-view-ir@0.1.0')
  assert.equal(result.value.semanticView.revision, 'sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083')
  assert.match(result.value.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(result.value.svg, /data-schema="re.semantic-view-ir@0.1.0"/)
  assert.match(result.value.svg, /data-fact-id="capability:@stdout"/)
  assert.match(result.value.svg, /data-evidence-uid="aaaaaadaaaaaaaaaaaaaaaaaaa"/)
  assert.equal(result.value.text, undefined)
})

test('review index source emits deterministic project facts', () => {
  const result = reviewIndexSource(canonicalHello, {
    file: 'canonical-hello.re',
    limit: 2,
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.schema, 're.project-review-index@0.1.0')
  assert.match(result.value.graph_revision, /^sha256:[0-9a-f]{64}$/)
  assert.match(result.value.index_revision, /^sha256:[0-9a-f]{64}$/)
  assert.match(result.value.module_interface_digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(result.value.entries.length, 2)
  assert.deepEqual(
    result.value.entries.map(({ fact_id }) => fact_id),
    [...result.value.entries.map(({ fact_id }) => fact_id)].sort(),
  )
  assert.ok(result.value.entries.every((entry) =>
    entry.graph_revision === result.value.graph_revision &&
    entry.index_revision === result.value.index_revision
  ))
  assert.notEqual(result.value.next_cursor, null)

  const unchanged = reviewIndexSource(canonicalHello, {
    changedSince: result.value.index_revision,
    file: 'canonical-hello.re',
  })
  assert.equal(unchanged.ok, true)
  assert.deepEqual(unchanged.value.entries, [])
})

test('profile source emits a deterministic path-free benchmark descriptor', () => {
  const first = profileSource(canonicalHello, { file: '/tmp/first/hello.re' })
  const second = profileSource(canonicalHello, { file: '/tmp/second/renamed.re' })

  assert.equal(first.ok, true)
  assert.deepEqual(first, second)
  assert.equal(
    first.value.benchmark_profile_digest,
    'sha256:df9b634c4571c4964b3b49198a36862300d95a39172e7cf8c833af6b691e0319',
  )
  assert.deepEqual(first.value, {
    benchmark_profile_digest:
      'sha256:df9b634c4571c4964b3b49198a36862300d95a39172e7cf8c833af6b691e0319',
    candidates: [
      { artifact_kind: 'native-aot', id: 'aot-llvm', role: 'production-candidate' },
      { artifact_kind: 'native-aot', id: 'cranelift', role: 'production-candidate' },
      { artifact_kind: 'native-aot', id: 'go-lowering', role: 'production-candidate' },
      { artifact_kind: 'managed-bytecode', id: 'jvm-bytecode', role: 'production-candidate' },
      { artifact_kind: 'host-script', id: 'node-reference', role: 'semantic-reference' },
    ],
    graph_revision: 'sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083',
    measurement_status: 'not-run',
    module_interface_digest: first.value.module_interface_digest,
    runtime: {
      kind: 'self-contained-node-demo-runtime',
    },
    schema: 're.profile-descriptor@0.1.0',
    target_profile: 'node-demo-self-contained-preview@0.1.0',
    workloads: [
      {
        id: 'cpu-pure-graph',
        required_axes: ['throughput_ops_sec', 'p99_ms', 'allocation_bytes', 'peak_rss_bytes'],
      },
      {
        id: 'json-http',
        required_axes: [
          'throughput_ops_sec',
          'p50_ms',
          'p95_ms',
          'p99_ms',
          'peak_rss_bytes',
          'local_adapter_overhead_ns',
        ],
      },
      {
        id: 'db-transaction',
        required_axes: [
          'throughput_ops_sec',
          'p50_ms',
          'p95_ms',
          'p99_ms',
          'foreign_adapter_overhead_ns',
        ],
      },
      {
        id: 'task-10k',
        required_axes: [
          'throughput_ops_sec',
          'p99_ms',
          'cancel_latency_p99_ms',
          'allocation_bytes',
          'peak_rss_bytes',
        ],
      },
      {
        id: 'task-100k',
        required_axes: [
          'throughput_ops_sec',
          'p99_ms',
          'cancel_latency_p99_ms',
          'allocation_bytes',
          'peak_rss_bytes',
          'gc_pause_p99_ms',
        ],
      },
      {
        id: 'module-50-clean-incremental',
        required_axes: ['clean_build_ms', 'incremental_build_ms', 'artifact_bytes'],
      },
      {
        id: 'module-500-clean-incremental',
        required_axes: [
          'clean_build_ms',
          'incremental_build_ms',
          'artifact_bytes',
          'peak_rss_bytes',
        ],
      },
      {
        id: 'module-5000-clean-incremental',
        required_axes: [
          'clean_build_ms',
          'incremental_build_ms',
          'artifact_bytes',
          'peak_rss_bytes',
        ],
      },
    ],
  })
  assert.equal(
    first.value.benchmark_profile_digest,
    backendMatrixDigest({
      candidates: first.value.candidates,
      schema: 're.benchmark-profile@0.1.0',
      workloads: first.value.workloads,
    }),
  )
  assert.match(first.value.module_interface_digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(first.value).includes('/tmp/'), false)
  assert.equal(JSON.stringify(first.value).includes('hello.re'), false)
  assert.equal(JSON.stringify(first.value).includes('renamed.re'), false)
  assert.equal(JSON.stringify(first.value).includes('eligibility'), false)
})

test('profile source assigns deterministic identity to compact input', () => {
  const first = profileSource(hello, { file: '/tmp/first/hello.re' })
  const second = profileSource(hello, { file: '/tmp/second/renamed.re' })

  assert.equal(first.ok, true)
  assert.deepEqual(first, second)
  assert.match(first.value.graph_revision, /^sha256:[0-9a-f]{64}$/)
})

test('build artifact embeds offline semantic view and review index evidence', () => {
  const result = buildSource(canonicalHello, {
    file: 'canonical-hello.re',
    sourceBytes: Buffer.from(canonicalHello, 'utf8'),
  })

  assert.equal(result.ok, true)
  assert.match(result.value.manifest.module_interface_digest, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(
    result.value.manifest.files.map(({ path }) => path),
    ['program.re', 'release-lock.json', 'run.mjs', 'review-index.json', 'semantic-view.json'],
  )
  const files = new Map(result.value.files.map((file) => [file.path, file]))
  const releaseLock = JSON.parse(files.get('release-lock.json').content)
  const semanticView = JSON.parse(files.get('semantic-view.json').content)
  const reviewIndex = JSON.parse(files.get('review-index.json').content)
  assert.equal(releaseLock.schema, 're.release-lock@0.1.0')
  assert.match(result.value.manifest.build_key, /^sha256:[0-9a-f]{64}$/)
  assert.equal(releaseLock.build_key, result.value.manifest.build_key)
  const buildKeyInput = {
    grammar_profile: EXECUTABLE_GRAMMAR_PROFILE.schema,
    graph_revision: result.value.manifest.graph_revision,
    identity_allocator: {
      algorithm: 're.deterministic-uid-sequence@0.1.0',
      schema: 're.identity-allocator@0.1.0',
    },
    module_interface_digest: result.value.manifest.module_interface_digest,
    runtime_kind: result.value.manifest.runtime.kind,
    schema: 're.preview-build-key@0.1.0',
    source_sha256: result.value.manifest.source_sha256,
    target_profile: result.value.manifest.target_profile,
    toolchain_implementation: 'node-demo-preview',
  }
  assert.equal(
    result.value.manifest.build_key,
    backendMatrixDigest(buildKeyInput),
  )
  assert.notEqual(
    backendMatrixDigest({ ...buildKeyInput, graph_revision: `sha256:${'0'.repeat(64)}` }),
    result.value.manifest.build_key,
  )
  assert.notEqual(
    backendMatrixDigest({ ...buildKeyInput, source_sha256: '0'.repeat(64) }),
    result.value.manifest.build_key,
  )
  assert.notEqual(
    backendMatrixDigest({
      ...buildKeyInput,
      grammar_profile: 're.executable-grammar-profile@9.0.0',
    }),
    result.value.manifest.build_key,
  )
  assert.deepEqual(releaseLock.language, {
    canonical_schema: EXECUTABLE_GRAMMAR_PROFILE.canonical_schema,
    grammar: EXECUTABLE_GRAMMAR_PROFILE.descriptor,
    grammar_profile: EXECUTABLE_GRAMMAR_PROFILE.schema,
    name: 'RE',
  })
  assert.equal(releaseLock.canonical.graph_revision, result.value.manifest.graph_revision)
  assert.equal(releaseLock.module_interface_digest, result.value.manifest.module_interface_digest)
  assert.equal(releaseLock.runtime.kind, 'self-contained-node-demo-runtime')
  assert.equal(
    releaseLock.runtime.target_profile,
    'node-demo-self-contained-preview@0.1.0',
  )
  assert.equal(semanticView.schema, 're.semantic-view-ir@0.1.0')
  assert.equal(semanticView.revision, result.value.manifest.graph_revision)
  assert.equal(reviewIndex.schema, 're.project-review-index@0.1.0')
  assert.equal(reviewIndex.graph_revision, result.value.manifest.graph_revision)
  assert.equal(
    reviewIndex.module_interface_digest,
    result.value.manifest.module_interface_digest,
  )
  assert.equal(
    result.value.manifest.preview_release.release_lock.sha256,
    sha256Hex(files.get('release-lock.json').content),
  )
  assert.equal(
    releaseLock.output_protocols.project_review_index.revision,
    reviewIndex.index_revision,
  )
  assert.equal(
    result.value.manifest.preview_release.review_index.revision,
    reviewIndex.index_revision,
  )
  assert.equal(
    result.value.manifest.preview_release.semantic_view.sha256,
    sha256Hex(files.get('semantic-view.json').content),
  )
  assert.match(files.get('checksums.sha256').content, /  manifest\.json\n/)
  assert.match(files.get('checksums.sha256').content, /  release-lock\.json\n/)
  assert.match(files.get('checksums.sha256').content, /  semantic-view\.json\n/)
  assert.equal(JSON.stringify(result.value.manifest).includes('canonical-hello.re'), false)
  assert.equal(JSON.stringify(releaseLock).includes('canonical-hello.re'), false)

  const changedSource = canonicalHello.replace('Hello, World!', 'Hello, build key!')
  const changed = buildSource(changedSource, {
    file: 'renamed.re',
    sourceBytes: Buffer.from(changedSource, 'utf8'),
  })
  assert.equal(changed.ok, true)
  assert.notEqual(changed.value.manifest.build_key, result.value.manifest.build_key)
})

test('schema parameter names can replace primary argument shorthand', () => {
  const source = hello
    .replace('@stdout.write("', '@stdout.write(data: "')
    .replace('process.exit(0)', 'process.exit(code: 0)')
    .replace('process.exit(1)', 'process.exit(code: 1)')

  const success = runSource(source, { file: 'named-arguments.re' })
  const failure = runSource(source, {
    file: 'named-arguments.re',
    host: { stdoutBroken: true },
  })

  assert.deepEqual(success, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: 'Hello, World!\n',
  })
  assert.deepEqual(failure, {
    outcome: { kind: 'process-status', status: { code: 1 } },
    programStdout: '',
  })
})

test('checker explains how to repair an unknown named argument', () => {
  const source = hello.replace(
    '@stdout.write("',
    '@stdout.write(message: "',
  )

  const result = checkSource(source, { file: 'wrong-argument.re' })

  assert.equal(result.ok, false)
  assert.deepEqual(result.diagnostics[0], {
    actual: 'message',
    code: 'unexpected-argument',
    column: 28,
    expected: ['data'],
    file: 'wrong-argument.re',
    line: 9,
    member: 'write',
    reference: 'process.stdout@0.1.0',
  })
})

test('checker rejects a non-exhaustive result match before execution', () => {
  const source = hello.replace('    err(_) => process.exit(1)\n', '')

  const result = runSource(source, { file: 'missing-err-arm.re' })

  assert.equal(result.outcome.kind, 'check-failure')
  assert.deepEqual(result.outcome.diagnostics[0], {
    code: 'non-exhaustive-match',
    column: 4,
    file: 'missing-err-arm.re',
    line: 8,
    missing: ['err'],
  })
  assert.equal(result.programStdout, '')
})

test('checker rejects duplicate result match variants', () => {
  const source = hello.replace(
    '    err(_) => process.exit(1)',
    '    ok(_) => process.exit(1)',
  )

  const result = checkSource(source, { file: 'duplicate-ok-arm.re' })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['duplicate-match-variant', 'non-exhaustive-match'],
  )
})

test('checker rejects an unpinned capability reference', () => {
  const source = hello.replace('process.stdout@0.1.0', 'io.write')

  const result = checkSource(source, { file: 'unpinned.re' })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'missing-schema-revision')
  assert.equal(result.diagnostics[0].reference, 'io.write')
})

test('checker reports one root diagnostic for an unknown capability member', () => {
  const source = hello.replace('@stdout.write', '@stdout.print')

  const result = checkSource(source, { file: 'unknown-member.re' })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['unknown-capability-member'],
  )
})

test('checker rejects an out-of-range process status before execution', () => {
  const source = hello.replace('process.exit(0', 'process.exit(256')

  const result = runSource(source, { file: 'invalid-status.re' })

  assert.equal(result.outcome.kind, 'check-failure')
  assert.equal(result.outcome.diagnostics[0].code, 'process-exit-code-out-of-range')
  assert.equal(result.programStdout, '')
})

test('parser reports unsupported syntax instead of silently executing it', () => {
  const source = hello.replace('process.exit', 'process.stop')

  const result = checkSource(source, { file: 'unsupported.re' })

  assert.equal(result.ok, false)
  assert.deepEqual(projectSourceDiagnostic(result.diagnostics[0]), {
    actual: 'process.stop',
    code: 'unexpected-token',
    column: 14,
    expected: 'process.exit',
    file: 'unsupported.re',
    line: 11,
  })
  assertSourceDiagnostic(result.diagnostics[0], source, {
    lexeme: 'process.stop',
    phase: 'parse',
    repair: {
      action: 'replace',
      expected: 'process.exit',
    },
    rule: 'compact.token-role',
  })
})

function projectSourceDiagnostic({
  actual,
  code,
  column,
  expected,
  file,
  line,
}) {
  return { actual, code, column, expected, file, line }
}

function assertSourceDiagnostic(diagnostic, source, {
  lexeme,
  phase,
  repair,
  rule,
}) {
  const start = source.lastIndexOf(lexeme)
  assert.notEqual(start, -1)
  const end = start + lexeme.length
  assert.equal(diagnostic.schema, 're.source-diagnostic@0.1.0')
  assert.equal(diagnostic.severity, 'error')
  assert.equal(diagnostic.phase, phase)
  assert.equal(diagnostic.rule, rule)
  assert.equal(diagnostic.lexeme, lexeme)
  assert.equal(
    diagnostic.byte_start,
    Buffer.byteLength(source.slice(0, start), 'utf8'),
  )
  assert.equal(
    diagnostic.byte_end,
    Buffer.byteLength(source.slice(0, end), 'utf8'),
  )
  assert.deepEqual(diagnostic.repair, repair ?? {
    action: 'replace',
    expected: diagnostic.expected,
  })
  assert.ok(diagnostic.end_line >= diagnostic.line)
  assert.ok(diagnostic.end_column > 0)
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
