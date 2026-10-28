import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'

import { parseExecutableGrammar } from '../src/toolchain/executable-grammar.js'
import { tokenizeCompactSource } from '../src/toolchain/compact-lexer.js'
import { parseProgram } from '../src/toolchain/parser.js'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const NATIVE_ROOT = join(ROOT, 'native')
const NATIVE_BINARY = join(NATIVE_ROOT, 'target', 'debug', 'revia')
const NATIVE_CONFORMANCE_BINARY = join(NATIVE_ROOT, 'target', 'debug', 'revia-conformance')

const EXECUTABLE_FIXTURES = [
  'examples/hello.re',
  'examples/args-check.re',
  'examples/read-check.re',
  'examples/read-encoding.re',
  'examples/write-check.re',
  'examples/agent-business-starter.re',
  'examples/agent-file-report.re',
  'examples/agent-args-policy.re',
]

test('native workspace builds offline with no third-party dependency graph', () => {
  const result = spawnSync('cargo', ['build', '--workspace', '--offline'], {
    cwd: NATIVE_ROOT,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(existsSync(NATIVE_BINARY), true)
})

test('native lexer token stream matches Node oracle on executable fixtures', async () => {
  ensureNativeBinary()
  for (const relative of EXECUTABLE_FIXTURES) {
    const file = join(ROOT, relative)
    const source = await readFile(file, 'utf8')
    const grammar = parseExecutableGrammar(source, { file: relative })
    assert.equal(grammar.ok, true, relative)
    const expected = tokenizeCompactSource(
      source.slice(grammar.value.bodyOffset),
      {
        file: relative,
        fullSource: source,
        sourceOffset: grammar.value.bodyOffset,
        startLine: 2,
      },
    )
    assert.equal(expected.ok, true, relative)
    const actual = runNative('lex', file)
    assert.equal(actual.status, 0, `${relative}: ${actual.stderr}`)
    const tokens = JSON.parse(actual.stdout).tokens
    assert.deepEqual(tokens, expected.tokens.map((token) => ({
      column: token.column,
      end: byteOffset(source, token.end),
      kind: token.kind,
      line: token.line,
      start: byteOffset(source, token.start),
      text: token.text,
    })), relative)
  }
})

test('native parser acceptance and diagnostic identity match Node oracle', async () => {
  ensureNativeBinary()
  for (const relative of EXECUTABLE_FIXTURES) {
    const file = join(ROOT, relative)
    const source = await readFile(file, 'utf8')
    const expected = parseProgram(source, { file: relative })
    assert.equal(expected.ok, true, relative)
    const actual = runNative('check', file)
    assert.equal(actual.status, 0, `${relative}: ${actual.stderr}`)
    assert.equal(JSON.parse(actual.stdout).ok, true, relative)
  }

  const invalidCases = [
    ['missing-header', 'unit @x', 'missing-grammar-header'],
    ['bad-header', 're 0.1\nunit @x', 'invalid-grammar-header'],
    ['unsupported-version', 're 9.9 compact\nunit @x', 'unsupported-language-version'],
    ['non-ascii-trivia', 're 0.1 compact\nunit\u00a0@x', 'non-ascii-compact-trivia'],
    ['annotation', 're 0.1 compact\n#[x]', 'unsupported-v1-annotation'],
    ['unterminated-string', 're 0.1 compact\nunit @x\nfn @main() -> process.status { %x = process.exit("', 'unterminated-string'],
    ['invalid-string', String.raw`re 0.1 compact
unit @x
fn @main() -> process.status { %x = process.exit("\q") }`, 'invalid-string-literal'],
    ['invalid-string-control', `re 0.1 compact
unit @x
cap @stdout: process.stdout@0.1.0
fn @main() -> process.status { %x = @stdout.write("a
b") }`, 'invalid-string-literal'],
    ['invalid-numeric', `re 0.1 compact
unit @x
fn @main() -> process.status { %x = process.exit(01) }`, 'invalid-numeric-literal'],
    ['invalid-decimal', `re 0.1 compact
unit @x
fn @main() -> process.status { %x = process.exit(1.) }`, 'invalid-numeric-literal'],
    ['decimal-scale', `re 0.1 compact
unit @x
fn @main() -> process.status { %x = process.exit(1.${'0'.repeat(256)}) }`, 'decimal-scale-out-of-range'],
    ['invalid-bytes', `re 0.1 compact
unit @x
cap @output: fs.write@0.1.0
fn @main() -> process.status { %x = @output.write_file(path: "output.txt", data: "hex:ABC") }`, 'invalid-bytes-literal'],
    ['unsupported-encoding', `re 0.1 compact
unit @x
cap @input: fs.read@0.1.0
fn @main() -> process.status { %x = @input.read_file(encoding: text.encoding.utf16) }`, 'unsupported-text-encoding'],
    ['parse-token', 're 0.1 compact\nunit @x\nbad', 'unexpected-token'],
  ]
  for (const [name, source, code] of invalidCases) {
    const file = join(NATIVE_ROOT, `target/${name}.re`)
    const path = writeFixture(file, Buffer.from(source, 'utf8'))
    const expected = parseProgram(source, { file: path })
    assert.equal(expected.ok, false, name)
    assert.equal(expected.diagnostics[0].code, code, name)
    const actual = runNative('check', path)
    assert.equal(actual.status, 65, `${name}: ${actual.stderr}`)
    const diagnostic = JSON.parse(actual.stdout).diagnostics[0]
    assert.deepEqual(normalizeDiagnostic(diagnostic), normalizeDiagnostic(expected.diagnostics[0]), name)
  }

  const escapedPair = String.raw`re 0.1 compact
unit @escaped_pair
cap @stdout: process.stdout@0.1.0
fn @main() -> process.status {
  %written = @stdout.write("\ud83d\ude00")
  return match %written {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
`
  const escapedPairPath = writeFixture(
    join(NATIVE_ROOT, 'target/escaped-pair.re'),
    Buffer.from(escapedPair, 'utf8'),
  )
  assert.equal(parseProgram(escapedPair, { file: escapedPairPath }).ok, true)
  assert.equal(runNative('check', escapedPairPath).status, 0)
})

test('native checker accepts canonical graphs and preserves their revision', () => {
  ensureNativeBinary()
  const canonical = join(ROOT, 'test', 'golden', 'canonical-hello.re')
  const checked = runNative('check', canonical)
  assert.equal(checked.status, 0, checked.stderr)
  assert.equal(JSON.parse(checked.stdout).ok, true)

  const manifest = runNative('manifest', canonical)
  assert.equal(manifest.status, 0, manifest.stderr)
  const value = JSON.parse(manifest.stdout)
  assert.equal(value.schema, 're.native-review-manifest@0.1.0')
  assert.equal(
    value.graph_revision,
    'sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083',
  )
  assert.ok(value.reachable.includes('return'))
  assert.deepEqual(value.executed, [])
  assert.equal(value.execution_evidence, 'not-collected')
})

test('native bytecode translator emits a verified graph-bound artifact', () => {
  ensureNativeBinary()
  const source = join(ROOT, 'examples', 'hello.re')
  const translated = runNativeArgs(['translate', source])
  assert.equal(translated.status, 0, translated.stderr)
  assert.match(translated.stdout, /^re 0\.1 bytecode\n/u)
  const artifact = writeFixture(
    join(NATIVE_ROOT, 'target', 'wp254-hello.bytecode'),
    Buffer.from(translated.stdout, 'utf8'),
  )
  const verified = runNativeArgs(['verify', source, artifact])
  assert.equal(verified.status, 0, verified.stderr)
  const result = JSON.parse(verified.stdout)
  assert.equal(result.ok, true)
  assert.equal(result.schema, 're.native-bytecode-verification@0.1.0')
  assert.match(result.artifact_digest, /^sha256:[0-9a-f]{64}$/u)

  const drifted = translated.stdout.replace('destination=0', 'destination=1')
  const driftedPath = writeFixture(
    join(NATIVE_ROOT, 'target', 'wp254-hello-drift.bytecode'),
    Buffer.from(drifted, 'utf8'),
  )
  const rejected = runNativeArgs(['verify', source, driftedPath])
  assert.equal(rejected.status, 65)
  assert.equal(JSON.parse(rejected.stdout).diagnostics[0].code, 'bytecode-register-invalid')
})

test('native conformance runner reports deterministic fixture outcomes', () => {
  ensureNativeConformanceBinary()
  const result = spawnSync(
    NATIVE_CONFORMANCE_BINARY,
    EXECUTABLE_FIXTURES,
    { cwd: ROOT, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report, {
    accepted_count: EXECUTABLE_FIXTURES.length,
    fixture_count: EXECUTABLE_FIXTURES.length,
    rejected_count: 0,
    results: EXECUTABLE_FIXTURES.map((file) => ({
      accepted: true,
      file,
    })),
    schema: 're.native-conformance-report@0.1.0',
  })
})

test('native release boundary contains no Node, JavaScript, or registry dependency', () => {
  ensureNativeBinary()
  const lock = readFileSync(join(NATIVE_ROOT, 'Cargo.lock'), 'utf8')
  assert.doesNotMatch(lock, /registry\+|git\+/u)

  const sourceFiles = listFiles(NATIVE_ROOT, {
    skip: new Set([join(NATIVE_ROOT, 'target')]),
  })
  assert.ok(sourceFiles.length > 0)
  assert.ok(sourceFiles.every((file) => !/\.(?:[cm]?js|map)$/u.test(file)), sourceFiles.join('\n'))

  const strings = printableStrings(readFileSync(NATIVE_BINARY))
  assert.doesNotMatch(strings, /(?:\/node_modules\/|node:|node\.js)/iu)

  if (process.platform === 'darwin' || process.platform === 'linux') {
    const dependencyCommand = process.platform === 'darwin' ? 'otool' : 'ldd'
    const dependencyArgs = process.platform === 'darwin' ? ['-L', NATIVE_BINARY] : [NATIVE_BINARY]
    const dependencies = spawnSync(dependencyCommand, dependencyArgs, { encoding: 'utf8' })
    assert.equal(dependencies.status, 0, dependencies.stderr)
    assert.doesNotMatch(dependencies.stdout, /(?:node|javascript)/iu)
  }
})

function ensureNativeBinary() {
  if (existsSync(NATIVE_BINARY)) return
  execFileSync('cargo', ['build', '--workspace', '--offline'], { cwd: NATIVE_ROOT })
}

function ensureNativeConformanceBinary() {
  if (existsSync(NATIVE_CONFORMANCE_BINARY)) return
  execFileSync('cargo', ['build', '--workspace', '--offline'], { cwd: NATIVE_ROOT })
}

function runNative(command, file) {
  return spawnSync(NATIVE_BINARY, [command, file], { encoding: 'utf8' })
}

function runNativeArgs(arguments_) {
  return spawnSync(NATIVE_BINARY, arguments_, { encoding: 'utf8' })
}

function byteOffset(source, codeUnitOffset) {
  return Buffer.byteLength(source.slice(0, codeUnitOffset), 'utf8')
}

function normalizeDiagnostic(diagnostic) {
  return {
    byte_end: diagnostic.byte_end,
    byte_start: diagnostic.byte_start,
    code: diagnostic.code,
    column: diagnostic.column,
    end_column: diagnostic.end_column,
    end_line: diagnostic.end_line,
    line: diagnostic.line,
    phase: diagnostic.phase,
    rule: diagnostic.rule,
  }
}

function writeFixture(file, bytes) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes)
  return file
}

function listFiles(directory, { skip = new Set() } = {}) {
  return readdirSync(directory).flatMap((entry) => {
    const file = join(directory, entry)
    if (skip.has(file)) return []
    if (statSync(file).isDirectory()) return listFiles(file, { skip })
    return [file]
  })
}

function printableStrings(bytes) {
  const strings = []
  let current = ''
  for (const byte of bytes) {
    if (byte >= 0x20 && byte <= 0x7e) {
      current += String.fromCharCode(byte)
      continue
    }
    if (current.length >= 4) strings.push(current)
    current = ''
  }
  if (current.length >= 4) strings.push(current)
  return strings.join('\n').split(sep).join('/')
}
