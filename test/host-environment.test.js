import assert from 'node:assert/strict'
import test from 'node:test'

import { demoSchemaDefinitions } from '../src/host/demo-schema.js'
import { HostEnvironment } from '../src/host/host-environment.js'
import { MemoryAdapter } from '../src/host/memory-adapter.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'

const fsReadDefinition = () => ({
  identity: 'fs.read',
  revision: '0.1.0',
  types: {
    'fs.read_error': {
      kind: 'error-sum',
      variants: [
        'not_found',
        'permission_denied',
        'outside_sandbox',
        'invalid_utf8',
        'io',
      ],
    },
  },
  members: {
    read_file: {
      access: ['read fs.file(path)'],
      params: [{ name: 'path', primary: true, type: 'fs.path' }],
      returns: 'result<text.utf8, fs.read_error>',
    },
  },
})

const fsWriteDefinition = () => ({
  identity: 'fs.write',
  revision: '0.1.0',
  types: {
    'fs.write_error': {
      kind: 'error-sum',
      variants: [
        'parent_not_found',
        'permission_denied',
        'outside_sandbox',
        'no_space',
        'io',
      ],
    },
  },
  members: {
    write_file: {
      access: ['write fs.file(path)'],
      params: [
        { name: 'path', primary: true, type: 'fs.path' },
        { name: 'data', type: 'bytes' },
      ],
      returns: 'result<unit, fs.write_error>',
    },
  },
})

class ThrowingAdapter {
  supportedInterfaces() {
    return ['fs.read@0.1.0']
  }

  invoke() {
    throw new Error('secret transport detail')
  }
}

class WrongReturnAdapter {
  supportedInterfaces() {
    return ['fs.read@0.1.0']
  }

  invoke() {
    return {
      kind: 'value',
      value: { kind: 'ok', value: Uint8Array.from([0x41]) },
    }
  }
}

class UndeclaredErrorVariantAdapter {
  supportedInterfaces() {
    return ['fs.write@0.1.0']
  }

  invoke() {
    return {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'remote_rejected' },
        kind: 'err',
      },
    }
  }
}

class WrongArgsReturnAdapter {
  supportedInterfaces() {
    return ['process.args@0.1.0']
  }

  invoke() {
    return {
      kind: 'value',
      value: {
        kind: 'ok',
        value: [Uint8Array.from([0x61])],
      },
    }
  }
}

class MalformedPayloadAdapter {
  supportedInterfaces() {
    return ['fs.read@0.1.0']
  }

  invoke() {
    return {
      fault: { reason: 'malformed-protocol-payload' },
      kind: 'host-fault',
    }
  }
}

class MismatchedResourceAdapter {
  supportedInterfaces() {
    return ['fs.read@0.1.0']
  }

  resourceCatalog() {
    return {
      'fs.file': {
        domain_digest: `sha256:${'f'.repeat(64)}`,
        segments: [],
      },
    }
  }

  resourceParents() {
    return {}
  }
}

class EchoEncodingAdapter {
  supportedInterfaces() {
    return ['fs.read@0.1.0']
  }

  invoke(_operation, typedArguments) {
    return {
      kind: 'value',
      value: { kind: 'ok', value: typedArguments.encoding },
    }
  }
}

test('BIND-001 binds an exact-reference adapter and invokes by instance', () => {
  const registry = SchemaRegistry.load([fsReadDefinition()]).value
  const adapter = new MemoryAdapter({
    files: new Map([
      ['input.txt', { bytes: Buffer.from('hello'), readable: true, writable: true }],
    ]),
  })

  const bound = HostEnvironment.bind({
    bindings: [{ adapter, instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  })

  assert.equal(bound.ok, true)
  assert.deepEqual(
    bound.value.invoke(
      '@input',
      'read_file',
      { path: 'input.txt' },
      'invoke-input-1',
    ),
    { kind: 'value', value: { kind: 'ok', value: 'hello' } },
  )
})

test('BIND-002 rejects a capability instance without a host binding', () => {
  const registry = SchemaRegistry.load([fsReadDefinition()]).value

  const bound = HostEnvironment.bind({
    bindings: [],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  })

  assert.deepEqual(bound, {
    ok: false,
    diagnostics: [
      {
        code: 'missing-host-binding',
        instance: '@input',
        reference: 'fs.read@0.1.0',
      },
    ],
  })
})

test('BIND-003 rejects ambiguous host bindings instead of choosing one', () => {
  const registry = SchemaRegistry.load([fsReadDefinition()]).value
  const first = new MemoryAdapter()
  const second = new MemoryAdapter()

  const bound = HostEnvironment.bind({
    bindings: [
      { adapter: first, instance: '@input' },
      { adapter: second, instance: '@input' },
    ],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  })

  assert.deepEqual(bound, {
    ok: false,
    diagnostics: [
      {
        code: 'ambiguous-host-binding',
        instance: '@input',
        reference: 'fs.read@0.1.0',
      },
    ],
  })
})

test('BIND-004 rejects an adapter that supports a different revision', () => {
  const newer = fsReadDefinition()
  newer.revision = '0.2.0'
  const registry = SchemaRegistry.load([newer]).value

  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new MemoryAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.2.0' }],
    registry,
  })

  assert.deepEqual(bound, {
    ok: false,
    diagnostics: [
      {
        code: 'adapter-interface-mismatch',
        instance: '@input',
        reference: 'fs.read@0.2.0',
      },
    ],
  })
})

test('binding fails before adapter matching when the schema revision is missing', () => {
  const registry = SchemaRegistry.load([]).value

  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new MemoryAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  })

  assert.deepEqual(bound, {
    ok: false,
    diagnostics: [
      {
        code: 'missing-schema-revision',
        instance: '@input',
        reference: 'fs.read@0.1.0',
      },
    ],
  })
})

test('BIND-005 rejects a member absent from the pinned interface', () => {
  const registry = SchemaRegistry.load([fsReadDefinition()]).value
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new MemoryAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  }).value

  assert.deepEqual(bound.invoke('@input', 'delete_file', {}, 'invoke-invalid-1'), {
    diagnostics: [
      {
        code: 'unknown-capability-member',
        instance: '@input',
        member: 'delete_file',
        reference: 'fs.read@0.1.0',
      },
    ],
    kind: 'check-failure',
  })
})

test('invoke rejects an undeclared capability instance before adapter dispatch', () => {
  const registry = SchemaRegistry.load([fsReadDefinition()]).value
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new MemoryAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  }).value

  assert.deepEqual(bound.invoke('@other', 'read_file', {}, 'invoke-invalid-2'), {
    diagnostics: [
      {
        code: 'unknown-capability-instance',
        instance: '@other',
      },
    ],
    kind: 'check-failure',
  })
})

test('typed argument validation rejects a missing required parameter', () => {
  const registry = SchemaRegistry.load([fsReadDefinition()]).value
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new MemoryAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  }).value

  assert.deepEqual(bound.invoke('@input', 'read_file', {}, 'invoke-invalid-3'), {
    diagnostics: [
      {
        code: 'missing-argument',
        instance: '@input',
        member: 'read_file',
        parameter: 'path',
        reference: 'fs.read@0.1.0',
      },
    ],
    kind: 'check-failure',
  })
})

test('typed argument validation rejects a value with the wrong type', () => {
  const registry = SchemaRegistry.load([fsReadDefinition()]).value
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new MemoryAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  }).value

  assert.deepEqual(
    bound.invoke('@input', 'read_file', { path: 7 }, 'invoke-invalid-4'),
    {
      diagnostics: [
        {
          actual: 'int',
          code: 'argument-type-mismatch',
          expected: 'fs.path',
          instance: '@input',
          member: 'read_file',
          parameter: 'path',
          reference: 'fs.read@0.1.0',
        },
      ],
      kind: 'check-failure',
    },
  )
})

test('typed argument validation rejects an unexpected named argument', () => {
  const registry = SchemaRegistry.load([fsReadDefinition()]).value
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new MemoryAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  }).value

  assert.deepEqual(
    bound.invoke(
      '@input',
      'read_file',
      { extra: true, path: 'input.txt' },
      'invoke-invalid-5',
    ),
    {
      diagnostics: [
        {
          code: 'unexpected-argument',
          instance: '@input',
          member: 'read_file',
          parameter: 'extra',
          reference: 'fs.read@0.1.0',
        },
      ],
      kind: 'check-failure',
    },
  )
})

test('typed argument validation expands schema defaults before dispatch', () => {
  const registry = SchemaRegistry.load(demoSchemaDefinitions()).value
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new EchoEncodingAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  }).value

  assert.deepEqual(
    bound.invoke(
      '@input',
      'read_file',
      { path: 'input.txt' },
      'invoke-default-1',
    ),
    {
      kind: 'value',
      value: { kind: 'ok', value: 'text.encoding.utf8' },
    },
  )
})

test('adapter-facing resource footprints are resolved from the pinned schema', () => {
  const definition = fsReadDefinition()
  definition.resource_catalog = {
    'fs.file': {
      domain_digest: `sha256:${'a'.repeat(64)}`,
      segments: [{
        parameter: 'path',
        type_digest: `sha256:${'b'.repeat(64)}`,
      }],
    },
  }
  const registry = SchemaRegistry.load([definition]).value
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new EchoEncodingAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  }).value

  assert.deepEqual(
    bound.resourceFootprint('@input', 'read_file', { path: 'tenant/input.txt' }),
    {
      ok: true,
      value: [{
        handle: null,
        mode: 'read',
        resource: {
          domain_digest: `sha256:${'a'.repeat(64)}`,
          segments: [{
            canonical_hex: Buffer.from('tenant/input.txt', 'utf8').toString('hex'),
            type_digest: `sha256:${'b'.repeat(64)}`,
          }],
        },
      }],
    },
  )
})

test('built-in adapters publish metadata matching the pinned schema and parent lineage is explicit', () => {
  const registry = SchemaRegistry.load(demoSchemaDefinitions()).value
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new MemoryAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  })
  assert.equal(bound.ok, true)
  assert.deepEqual(
    bound.value.resourceLineage('@input', 'fs.file'),
    { ok: true, value: ['fs.file', 'fs.storage'] },
  )
})

test('adapter metadata mismatch fails closed before binding', () => {
  const registry = SchemaRegistry.load(demoSchemaDefinitions()).value
  assert.deepEqual(
    HostEnvironment.bind({
      bindings: [{ adapter: new MismatchedResourceAdapter(), instance: '@input' }],
      capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
      registry,
    }),
    {
      ok: false,
      diagnostics: [
        {
          code: 'adapter-resource-catalog-mismatch',
          constructor: 'fs.file',
          instance: '@input',
          reference: 'fs.read@0.1.0',
        },
        {
          code: 'adapter-resource-catalog-mismatch',
          constructor: 'fs.storage',
          instance: '@input',
          reference: 'fs.read@0.1.0',
        },
        {
          code: 'adapter-resource-parent-mismatch',
          instance: '@input',
          reference: 'fs.read@0.1.0',
        },
      ],
    },
  )
})

test('adapter exceptions become sanitized host-contract-violation outcomes', () => {
  const registry = SchemaRegistry.load([fsReadDefinition()]).value
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new ThrowingAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  }).value

  assert.deepEqual(
    bound.invoke(
      '@input',
      'read_file',
      { path: 'input.txt' },
      'invoke-fault-1',
    ),
    {
      fault: {
        capability_instance: '@input',
        capability_reference: 'fs.read@0.1.0',
        code: 'host-contract-violation',
        invocation_id: 'invoke-fault-1',
        member: 'read_file',
        phase: 'invoke',
        reason: 'adapter-panicked',
      },
      kind: 'host-fault',
    },
  )
})

test('adapter values that violate returns become host faults', () => {
  const registry = SchemaRegistry.load([fsReadDefinition()]).value
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: new WrongReturnAdapter(), instance: '@input' }],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  }).value

  assert.deepEqual(
    bound.invoke(
      '@input',
      'read_file',
      { path: 'input.txt' },
      'invoke-fault-2',
    ),
    {
      fault: {
        capability_instance: '@input',
        capability_reference: 'fs.read@0.1.0',
        code: 'host-contract-violation',
        invocation_id: 'invoke-fault-2',
        member: 'read_file',
        phase: 'invoke',
        reason: 'return-type-mismatch',
      },
      kind: 'host-fault',
    },
  )
})

test('WRITE-004 rejects an adapter error outside the closed error sum', () => {
  const registry = SchemaRegistry.load([fsWriteDefinition()]).value
  const bound = HostEnvironment.bind({
    bindings: [
      { adapter: new UndeclaredErrorVariantAdapter(), instance: '@output' },
    ],
    capabilities: [{ instance: '@output', reference: 'fs.write@0.1.0' }],
    registry,
  }).value

  assert.deepEqual(
    bound.invoke(
      '@output',
      'write_file',
      { data: Uint8Array.from([0x41]), path: 'output.txt' },
      'invoke-fault-3',
    ),
    {
      fault: {
        capability_instance: '@output',
        capability_reference: 'fs.write@0.1.0',
        code: 'host-contract-violation',
        invocation_id: 'invoke-fault-3',
        member: 'write_file',
        phase: 'invoke',
        reason: 'undeclared-error-variant',
      },
      kind: 'host-fault',
    },
  )
})

test('ARGS-004 rejects list<bytes> returned as list<text.utf8>', () => {
  const registry = SchemaRegistry.load(demoSchemaDefinitions()).value
  const bound = HostEnvironment.bind({
    bindings: [
      { adapter: new WrongArgsReturnAdapter(), instance: '@args' },
    ],
    capabilities: [
      { instance: '@args', reference: 'process.args@0.1.0' },
    ],
    registry,
  }).value

  assert.deepEqual(bound.invoke('@args', 'read', {}, 'invoke-args-4'), {
    fault: {
      capability_instance: '@args',
      capability_reference: 'process.args@0.1.0',
      code: 'host-contract-violation',
      invocation_id: 'invoke-args-4',
      member: 'read',
      phase: 'invoke',
      reason: 'return-type-mismatch',
    },
    kind: 'host-fault',
  })
})

test('READ-006 contextualizes a malformed transport payload as a host fault', () => {
  const registry = SchemaRegistry.load([fsReadDefinition()]).value
  const bound = HostEnvironment.bind({
    bindings: [
      { adapter: new MalformedPayloadAdapter(), instance: '@input' },
    ],
    capabilities: [{ instance: '@input', reference: 'fs.read@0.1.0' }],
    registry,
  }).value

  assert.deepEqual(
    bound.invoke(
      '@input',
      'read_file',
      { path: 'input.txt' },
      'invoke-read-6',
    ),
    {
      fault: {
        capability_instance: '@input',
        capability_reference: 'fs.read@0.1.0',
        code: 'host-contract-violation',
        invocation_id: 'invoke-read-6',
        member: 'read_file',
        phase: 'invoke',
        reason: 'malformed-protocol-payload',
      },
      kind: 'host-fault',
    },
  )
})
