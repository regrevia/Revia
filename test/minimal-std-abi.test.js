import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  moduleInterfaceDigest,
} from '../src/toolchain/module-contract.js'
import {
  createMinimalStdAbiReport,
  minimalStdAbiReportDigest,
  validateMinimalStdAbiCorpus,
  verifyMinimalStdAbiReport,
} from '../src/toolchain/minimal-std-abi.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/minimal-std-abi.json', import.meta.url),
  'utf8',
))

test('minimal std ABI freezes four host-independent module contracts', () => {
  assert.deepEqual(validateMinimalStdAbiCorpus(corpus), { ok: true })
  const created = createMinimalStdAbiReport(corpus)
  assert.equal(created.ok, true)
  assert.deepEqual(verifyMinimalStdAbiReport(created.value, corpus), { ok: true })
  assert.equal(
    created.value.modules.map(({ module }) => module).join(','),
    'std.bytes,std.list,std.result,std.text',
  )
  assert.deepEqual(
    created.value.modules.map(({ module, operations }) => ({
      module,
      operations: operations.map(({ name }) => name),
    })),
    [
      { module: 'std.bytes', operations: ['byte_count', 'concat', 'decode_utf8'] },
      { module: 'std.list', operations: ['append', 'concat', 'length'] },
      { module: 'std.result', operations: ['is_err', 'is_ok'] },
      { module: 'std.text', operations: ['concat', 'encode_utf8', 'scalar_count'] },
    ],
  )
  assert.equal(created.value.package_manifest.package, 'std')
  assert.equal(created.value.package_manifest.modules.length, 4)
  assert.match(created.value.package_digest, /^sha256:[0-9a-f]{64}$/u)
  assert.match(created.value.report_digest, /^sha256:[0-9a-f]{64}$/u)
})

test('minimal std ABI canonical identity ignores named collection order only', () => {
  const reordered = structuredClone(corpus)
  reordered.modules.reverse()
  for (const module of reordered.modules) {
    module.operations.reverse()
    module.types.reverse()
    for (const operation of module.operations) {
      operation.parameters.reverse()
    }
  }
  const original = createMinimalStdAbiReport(corpus)
  const shuffled = createMinimalStdAbiReport(reordered)

  assert.equal(original.ok, true)
  assert.equal(shuffled.ok, true)
  assert.deepEqual(shuffled.value, original.value)
})

test('minimal std ABI rejects missing, duplicate, invented, host, and generic drift', () => {
  const cases = []

  const missing = structuredClone(corpus)
  missing.modules[0].operations.pop()
  cases.push(['minimal-std-abi-operation-set-mismatch', missing])

  const duplicate = structuredClone(corpus)
  duplicate.modules.push(structuredClone(duplicate.modules[0]))
  cases.push(['minimal-std-abi-module-set-mismatch', duplicate])

  const invented = structuredClone(corpus)
  invented.modules[3].operations.push({
    ...structuredClone(invented.modules[3].operations[0]),
    name: 'locale_compare',
  })
  cases.push(['minimal-std-abi-operation-set-mismatch', invented])

  const host = structuredClone(corpus)
  host.modules[3].operations[0].host_adapter = 'node'
  cases.push(['minimal-std-abi-operation-fields-mismatch', host])

  const generic = structuredClone(corpus)
  generic.modules[1].operations[0].type_parameters = ['value']
  cases.push(['minimal-std-abi-operation-contract-mismatch', generic])

  const error = structuredClone(corpus)
  error.modules[0].operations[2].error_variants = []
  cases.push(['minimal-std-abi-operation-contract-mismatch', error])

  for (const [code, candidate] of cases) {
    const result = validateMinimalStdAbiCorpus(candidate)
    assert.equal(result.ok, false, code)
    assert.equal(result.diagnostics[0].code, code)
  }
})

test('minimal std ABI rejects synchronized report and manifest drift', () => {
  const created = createMinimalStdAbiReport(corpus)
  assert.equal(created.ok, true)

  const operation = structuredClone(created.value)
  operation.modules[0].operations[0].result = {
    kind: 'primitive',
    name: 'text.utf8',
  }
  const { contract_digest: ignored, ...operationContract } =
    operation.modules[0].operations[0]
  operation.modules[0].operations[0].contract_digest =
    canonicalDigest(operationContract)
  operation.report_digest = minimalStdAbiReportDigest(operation)
  assert.equal(
    verifyMinimalStdAbiReport(operation, corpus).diagnostics[0].code,
    'minimal-std-abi-report-authority-mismatch',
  )

  const manifest = structuredClone(created.value)
  manifest.modules[0].interface.exports[0].contract_digest =
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  manifest.modules[0].interface_digest =
    moduleInterfaceDigest(manifest.modules[0].interface)
  manifest.package_manifest.modules[0].interface_digest =
    manifest.modules[0].interface_digest
  manifest.package_digest = canonicalDigest(manifest.package_manifest)
  manifest.report_digest = minimalStdAbiReportDigest(manifest)
  assert.equal(
    verifyMinimalStdAbiReport(manifest, corpus).diagnostics[0].code,
    'minimal-std-abi-report-authority-mismatch',
  )
})

test('minimal std ABI rejects malformed report collections with a stable code', () => {
  const created = createMinimalStdAbiReport(corpus)
  assert.equal(created.ok, true)
  const malformed = structuredClone(created.value)
  malformed.modules[0].operations = null
  malformed.report_digest = minimalStdAbiReportDigest(malformed)

  assert.equal(
    verifyMinimalStdAbiReport(malformed, corpus).diagnostics[0].code,
    'minimal-std-abi-report-module-invalid',
  )
})

function canonicalDigest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`
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
