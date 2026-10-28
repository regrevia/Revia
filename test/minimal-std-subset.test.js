import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createMinimalStdAbiReport,
} from '../src/toolchain/minimal-std-abi.js'
import {
  checkMinimalStdInvocation,
  executeMinimalStdOperation,
  manifestMinimalStdInvocation,
  minimalStdCapabilityDigest,
  minimalStdCapabilityManifest,
  minimalStdPackageIdentityForGraph,
  minimalStdRuntimePackageDigest,
  minimalStdRuntimePackageManifest,
  replayMinimalStdTranslation,
  translateMinimalStdInvocation,
} from '../src/toolchain/minimal-std-subset.js'
import {
  checkSource,
  reviewSource,
  runSource,
  translateSource,
} from '../src/toolchain/demo-toolchain.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/minimal-std-abi.json', import.meta.url),
  'utf8',
))
const abi = createMinimalStdAbiReport(corpus)
assert.equal(abi.ok, true)
const graphRevision = `sha256:${'1'.repeat(64)}`

function invoke(operation, parameters, type_arguments = []) {
  return executeMinimalStdOperation({
    graph_revision: graphRevision,
    operation,
    package_manifest: abi.value.package_manifest,
    parameters,
    schema: 're.minimal-std-invocation@0.1.0',
    type_arguments,
  })
}

test('minimal std subset executes every frozen host-independent operation', () => {
  const bytes = new Uint8Array([0x61, 0xf0, 0x9f, 0x98, 0x80])
  assert.equal(invoke('std.bytes.byte_count', { value: bytes }).value.outcome, '5')
  assert.deepEqual(
    invoke('std.bytes.concat', {
      left: new Uint8Array([0x61]),
      right: new Uint8Array([0x62]),
    }).value.outcome,
    new Uint8Array([0x61, 0x62]),
  )
  assert.deepEqual(invoke('std.bytes.decode_utf8', { value: bytes }).value.outcome, {
    kind: 'ok', value: 'a😀',
  })
  assert.deepEqual(invoke('std.bytes.decode_utf8', {
    value: new Uint8Array([0xc3, 0x28]),
  }).value.outcome, {
    error: {
      type: 'std.bytes.decode_error',
      variant: 'invalid_utf8',
    },
    kind: 'err',
  })

  assert.deepEqual(invoke('std.list.append', {
    value: { record: ['a'] },
    values: [{ record: ['b'] }],
  }, ['record']).value.outcome, [{ record: ['b'] }, { record: ['a'] }])
  assert.deepEqual(invoke('std.list.concat', {
    left: ['a'],
    right: ['b', 'c'],
  }, ['text.utf8']).value.outcome, ['a', 'b', 'c'])
  assert.equal(
    invoke('std.list.length', { values: ['a', 'b'] }, ['text.utf8']).value.outcome,
    '2',
  )
  assert.deepEqual(invoke('std.result.is_err', {
    value: { error: 'no', kind: 'err' },
  }, ['text.utf8', 'std.error']).value.outcome, true)
  assert.deepEqual(invoke('std.result.is_ok', {
    value: { kind: 'ok', value: 'yes' },
  }, ['text.utf8', 'std.error']).value.outcome, true)
  const decodedError = invoke('std.bytes.decode_utf8', {
    value: new Uint8Array([0xc3, 0x28]),
  }).value.outcome
  assert.equal(invoke('std.result.is_err', {
    value: decodedError,
  }, ['text.utf8', 'std.bytes.decode_error']).value.outcome, true)

  assert.equal(invoke('std.text.concat', {
    left: 'a', right: '😀',
  }).value.outcome, 'a😀')
  assert.deepEqual(
    invoke('std.text.encode_utf8', { value: 'a😀' }).value.outcome,
    bytes,
  )
  assert.equal(invoke('std.text.scalar_count', { value: 'a😀' }).value.outcome, '2')
  const receipt = invoke('std.text.scalar_count', { value: 'a😀' }).value
  assert.equal(receipt.graph_revision, graphRevision)
  assert.equal(receipt.operation, 'std.text.scalar_count')
  assert.equal(receipt.package_digest, abi.value.package_digest)
  assert.match(receipt.receipt_digest, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(receipt.schema, 're.minimal-std-operation-receipt@0.1.0')
})

test('minimal std subset snapshots generic payloads and rejects authority or input drift', () => {
  const payload = { nested: ['stable'] }
  const result = invoke('std.list.append', {
    value: payload,
    values: [],
  }, ['record'])
  assert.equal(result.ok, true)
  payload.nested[0] = 'mutated'
  assert.deepEqual(result.value.outcome, [{ nested: ['stable'] }])

  for (const [label, input, code] of [
    [
      'unknown operation',
      {
        graph_revision: graphRevision,
        operation: 'std.text.locale_compare',
        package_manifest: abi.value.package_manifest,
        parameters: {},
        schema: 're.minimal-std-invocation@0.1.0',
        type_arguments: [],
      },
      'minimal-std-subset-operation-unknown',
    ],
    [
      'resigned package',
      {
        graph_revision: graphRevision,
        operation: 'std.text.concat',
        package_manifest: {
          ...abi.value.package_manifest,
          modules: abi.value.package_manifest.modules.map((entry, index) => (
            index === 0
              ? { ...entry, interface_digest: `sha256:${'a'.repeat(64)}` }
              : entry
          )),
        },
        parameters: { left: 'a', right: 'b' },
        schema: 're.minimal-std-invocation@0.1.0',
        type_arguments: [],
      },
      'minimal-std-subset-package-authority-mismatch',
    ],
    [
      'wrong generic arity',
      {
        graph_revision: graphRevision,
        operation: 'std.list.length',
        package_manifest: abi.value.package_manifest,
        parameters: { values: [] },
        schema: 're.minimal-std-invocation@0.1.0',
        type_arguments: [],
      },
      'minimal-std-subset-type-arguments-mismatch',
    ],
    [
      'unknown parameter',
      {
        graph_revision: graphRevision,
        operation: 'std.text.concat',
        package_manifest: abi.value.package_manifest,
        parameters: { left: 'a', right: 'b', locale: 'en' },
        schema: 're.minimal-std-invocation@0.1.0',
        type_arguments: [],
      },
      'minimal-std-subset-parameters-mismatch',
    ],
    [
      'malformed text',
      {
        graph_revision: graphRevision,
        operation: 'std.text.encode_utf8',
        package_manifest: abi.value.package_manifest,
        parameters: { value: '\ud800' },
        schema: 're.minimal-std-invocation@0.1.0',
        type_arguments: [],
      },
      'minimal-std-subset-argument-type-mismatch',
    ],
    [
      'missing graph revision',
      {
        operation: 'std.text.concat',
        package_manifest: abi.value.package_manifest,
        parameters: { left: 'a', right: 'b' },
        schema: 're.minimal-std-invocation@0.1.0',
        type_arguments: [],
      },
      'minimal-std-subset-invocation-fields-mismatch',
    ],
  ]) {
    const result = executeMinimalStdOperation(input)
    assert.equal(result.ok, false, label)
    assert.equal(result.diagnostics[0].code, code, label)
    assert.equal(
      checkMinimalStdInvocation(input).diagnostics[0].code,
      code,
      `${label} check`,
    )
  }

  const malformedResult = request('std.result.is_ok', {
    value: { kind: 'ok', value: 'yes', injected: true },
  }, ['text.utf8', 'text.utf8'])
  assert.equal(
    checkMinimalStdInvocation(malformedResult).diagnostics[0].code,
    'minimal-std-subset-argument-type-mismatch',
  )
  assert.equal(
    checkMinimalStdInvocation(request('std.list.append', {
      value: new Date(0),
      values: [],
    }, ['host.date'])).diagnostics[0].code,
    'minimal-std-subset-argument-type-mismatch',
  )

  let getterCalls = 0
  const accessorParameters = {}
  Object.defineProperty(accessorParameters, 'value', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'hidden'
    },
  })
  const accessor = checkMinimalStdInvocation(request(
    'std.text.scalar_count',
    accessorParameters,
  ))
  assert.equal(accessor.ok, false)
  assert.equal(
    accessor.diagnostics[0].code,
    'minimal-std-subset-parameter-witness-invalid',
  )
  assert.equal(getterCalls, 0)

  let proxyCalls = 0
  const proxiedParameters = new Proxy({ value: 'hidden' }, {
    getPrototypeOf() {
      proxyCalls += 1
      return Object.prototype
    },
    getOwnPropertyDescriptor() {
      proxyCalls += 1
      return undefined
    },
    ownKeys() {
      proxyCalls += 1
      return ['value']
    },
  })
  const proxied = checkMinimalStdInvocation(request(
    'std.text.scalar_count',
    proxiedParameters,
  ))
  assert.equal(proxied.ok, false)
  assert.equal(
    proxied.diagnostics[0].code,
    'minimal-std-subset-parameter-witness-invalid',
  )
  assert.equal(proxyCalls, 0)

  const sparse = checkMinimalStdInvocation(request(
    'std.list.length',
    { values: Array(1) },
    ['text.utf8'],
  ))
  assert.equal(sparse.ok, false)
  assert.equal(
    sparse.diagnostics[0].code,
    'minimal-std-subset-parameter-witness-invalid',
  )
})

test('minimal std invocation check manifest run and translate share exact revision', () => {
  const requests = [
    request('std.bytes.byte_count', { value: new Uint8Array([1]) }),
    request('std.bytes.concat', {
      left: new Uint8Array([1]), right: new Uint8Array([2]),
    }),
    request('std.bytes.decode_utf8', { value: new Uint8Array([0x61]) }),
    request('std.list.append', { value: 'b', values: ['a'] }, ['text.utf8']),
    request('std.list.concat', { left: ['a'], right: ['b'] }, ['text.utf8']),
    request('std.list.length', { values: ['a'] }, ['text.utf8']),
    request('std.result.is_err', {
      value: { error: 'x', kind: 'err' },
    }, ['text.utf8', 'text.utf8']),
    request('std.result.is_ok', {
      value: { kind: 'ok', value: 'x' },
    }, ['text.utf8', 'text.utf8']),
    request('std.text.concat', { left: 'a', right: 'b' }),
    request('std.text.encode_utf8', { value: 'a' }),
    request('std.text.scalar_count', { value: 'a' }),
  ]

  for (const input of requests) {
    const checked = checkMinimalStdInvocation(input)
    const manifest = manifestMinimalStdInvocation(input)
    const run = executeMinimalStdOperation(input)
    const translated = translateMinimalStdInvocation(input)
    assert.equal(checked.ok, true, input.operation)
    assert.equal(manifest.ok, true, input.operation)
    assert.equal(run.ok, true, input.operation)
    assert.equal(translated.ok, true, input.operation)
    assert.equal(manifest.value.graph_revision, graphRevision)
    assert.equal(run.value.graph_revision, graphRevision)
    assert.equal(translated.value.graph_revision, graphRevision)
    assert.equal(manifest.value.package_digest, abi.value.package_digest)
    assert.equal(run.value.package_digest, abi.value.package_digest)
    assert.equal(translated.value.package_digest, abi.value.package_digest)
    assert.equal(manifest.value.invocation_digest, checked.value.invocation_digest)
    assert.equal(run.value.invocation_digest, checked.value.invocation_digest)
    assert.equal(translated.value.invocation_digest, checked.value.invocation_digest)
    assert.deepEqual(manifest.value.parameter_witness, checked.value.parameter_witness)
    assert.deepEqual(run.value.parameter_witness, checked.value.parameter_witness)
    assert.deepEqual(translated.value.parameter_witness, checked.value.parameter_witness)
    assert.equal(
      manifest.value.parameter_witness_digest,
      checked.value.parameter_witness_digest,
    )
    assert.equal(run.value.runtime_package_digest, minimalStdRuntimePackageDigest())
    assert.equal(translated.value.capability_digest, minimalStdCapabilityDigest())
    assert.deepEqual(
      replayMinimalStdTranslation(translated.value, {
        checked: checked.value,
      }),
      run,
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(translated.value.parameter_witness)),
      translated.value.parameter_witness,
    )
  }

  const original = request('std.text.concat', { left: 'a', right: 'b' })
  const changed = request('std.text.concat', { left: 'a', right: 'c' })
  const originalChecked = checkMinimalStdInvocation(original)
  const changedChecked = checkMinimalStdInvocation(changed)
  assert.notEqual(
    originalChecked.value.invocation_digest,
    changedChecked.value.invocation_digest,
  )
  const resigned = translateMinimalStdInvocation(changed)
  assert.equal(resigned.ok, true)
  const staleReplay = replayMinimalStdTranslation(resigned.value, {
    checked: originalChecked.value,
  })
  assert.equal(staleReplay.ok, false)
  assert.equal(
    staleReplay.diagnostics[0].code,
    'minimal-std-subset-replay-authority-mismatch',
  )

  const injected = {
    ...requests[0],
    capability: 'host.bytes',
  }
  assert.equal(
    checkMinimalStdInvocation(injected).diagnostics[0].code,
    'minimal-std-subset-invocation-fields-mismatch',
  )
})

test('canonical std decode binds check manifest run and translate to one package identity', () => {
  const valid = canonicalDecode('f09f9880')
  const invalid = canonicalDecode('c328')
  const packageIdentity = minimalStdPackageIdentityForGraph(
    checkSource(valid, { file: 'valid.re' }).program,
  )
  assert.equal(packageIdentity.ok, true)

  for (const [source, code] of [[valid, 0], [invalid, 1]]) {
    const checked = checkSource(source, { file: 'decode.re' })
    assert.equal(checked.ok, true)
    assert.equal(checked.program.graph_revision, undefined)

    const manifest = reviewSource(source, { file: 'decode.re' })
    assert.equal(manifest.ok, true)
    assert.equal(
      manifest.value.std_package_digest,
      packageIdentity.value.package_digest,
    )
    assert.deepEqual(manifest.value.std_modules, ['std.bytes'])

    const run = runSource(source, { file: 'decode.re' })
    assert.deepEqual(run, {
      outcome: { kind: 'process-status', status: { code } },
      programStdout: '',
    })

    const translated = translateSource(source, { file: 'decode.re' })
    assert.equal(translated.ok, true)
    assert.equal(
      translated.value.std_package_digest,
      packageIdentity.value.package_digest,
    )
    assert.equal(
      manifest.value.std_runtime_package_digest,
      minimalStdRuntimePackageDigest(),
    )
    assert.equal(
      translated.value.std_capability_digest,
      minimalStdCapabilityDigest(),
    )
  }

  const unsupported = checkSource(canonicalByteCount(), {
    file: 'byte-count.re',
  })
  assert.equal(unsupported.ok, false)
  assert.equal(
    unsupported.diagnostics[0].code,
    'std-operation-graph-representation-unsupported',
  )
})

test('minimal std runtime package binds the frozen ABI to an empty capability boundary', () => {
  assert.deepEqual(minimalStdCapabilityManifest(), {
    capabilities: [],
    package_digest: abi.value.package_digest,
    schema: 're.minimal-std-capability-manifest@0.1.0',
  })
  assert.match(minimalStdCapabilityDigest(), /^sha256:[0-9a-f]{64}$/u)
  assert.deepEqual(minimalStdRuntimePackageManifest(), {
    abi_package_digest: abi.value.package_digest,
    capability_digest: minimalStdCapabilityDigest(),
    implementation: 're.minimal-std-subset@0.1.0',
    modules: ['std.bytes', 'std.list', 'std.result', 'std.text'],
    schema: 're.minimal-std-runtime-package@0.1.0',
  })
  assert.match(minimalStdRuntimePackageDigest(), /^sha256:[0-9a-f]{64}$/u)
})

function canonicalDecode(bytes) {
  return `re 0.1 canonical
unit @std_decode
fn %uaaaaaaa: uid("aaaaaaaaaaaaaaaaaaaaaaaaaa"): @main -> process.status {
  literal %uaaaaaab: uid("aaaaaabaaaaaaaaaaaaaaaaaaa"): bytes = hex:${bytes}
  literal %uaaaaaae: uid("aaaaaaeaaaaaaaaaaaaaaaaaaa"): int = 0
  literal %uaaaaaai: uid("aaaaaaiaaaaaaaaaaaaaaaaaaa"): int = 1
  let %uaaaaaac: uid("aaaaaacaaaaaaaaaaaaaaaaaaa"): %decoded = call %uaaaaaad: uid("aaaaaadaaaaaaaaaaaaaaaaaaa"): std.bytes.decode_utf8@0.1.0(value: %uaaaaaab)
  return %uaaaaaaf: uid("aaaaaafaaaaaaaaaaaaaaaaaaa"): match %uaaaaaag: uid("aaaaaagaaaaaaaaaaaaaaaaaaa"): %uaaaaaac {
    branch %uaaaaaaj: uid("aaaaaajaaaaaaaaaaaaaaaaaaa"): err => call %uaaaaaak: uid("aaaaaakaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaai)
    branch %uaaaaaal: uid("aaaaaalaaaaaaaaaaaaaaaaaaa"): ok => call %uaaaaaam: uid("aaaaaamaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaae)
  }
}
`
}

function request(operation, parameters, type_arguments = []) {
  return {
    graph_revision: graphRevision,
    operation,
    package_manifest: abi.value.package_manifest,
    parameters,
    schema: 're.minimal-std-invocation@0.1.0',
    type_arguments,
  }
}

function canonicalByteCount() {
  return `re 0.1 canonical
unit @std_byte_count
fn %ubaaaaaa: uid("baaaaaaaaaaaaaaaaaaaaaaaaa"): @main -> process.status {
  literal %ubaaaaab: uid("baaaaabaaaaaaaaaaaaaaaaaaa"): bytes = hex:61
  literal %ubaaaaae: uid("baaaaaeaaaaaaaaaaaaaaaaaaa"): int = 0
  literal %ubaaaaai: uid("baaaaaiaaaaaaaaaaaaaaaaaaa"): int = 1
  let %ubaaaaac: uid("baaaaacaaaaaaaaaaaaaaaaaaa"): %count = call %ubaaaaad: uid("baaaaadaaaaaaaaaaaaaaaaaaa"): std.bytes.byte_count@0.1.0(value: %ubaaaaab)
  return %ubaaaaaf: uid("baaaaafaaaaaaaaaaaaaaaaaaa"): match %ubaaaaag: uid("baaaaagaaaaaaaaaaaaaaaaaaa"): %ubaaaaac {
    branch %ubaaaaaj: uid("baaaaajaaaaaaaaaaaaaaaaaaa"): err => call %ubaaaaak: uid("baaaaakaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %ubaaaaai)
    branch %ubaaaaal: uid("baaaaalaaaaaaaaaaaaaaaaaaa"): ok => call %ubaaaaam: uid("baaaaamaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %ubaaaaae)
  }
}
`
}
