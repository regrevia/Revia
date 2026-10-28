import assert from 'node:assert/strict'
import test from 'node:test'

import { demoSchemaDefinitions } from '../src/host/demo-schema.js'
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
      params: [
        { name: 'path', primary: true, type: 'fs.path' },
        {
          default: 'text.encoding.utf8',
          name: 'encoding',
          type: 'text.encoding',
        },
      ],
      returns: 'result<text.utf8, fs.read_error>',
      access: ['read fs.file(path)'],
    },
  },
})

const stdoutDefinition = () => ({
  identity: 'process.stdout',
  revision: '0.1.0',
  types: {
    'io.write_error': {
      kind: 'error-sum',
      variants: ['broken_pipe', 'io'],
    },
  },
  members: {
    write: {
      params: [{ name: 'data', primary: true, type: 'text.utf8' }],
      returns: 'result<unit, io.write_error>',
      access: ['write process.stdout'],
    },
  },
})

test('REG-001 loads and resolves an exact schema revision', () => {
  const loaded = SchemaRegistry.load([fsReadDefinition()])

  assert.equal(loaded.ok, true)
  assert.deepEqual(loaded.value.resolve('fs.read@0.1.0'), {
    ok: true,
    value: fsReadDefinition(),
  })
})

test('REG-007 pins a schema revision to a stable content digest', () => {
  const loaded = SchemaRegistry.load([fsReadDefinition()])
  assert.equal(loaded.ok, true)
  const digest = loaded.value.contentDigest('fs.read@0.1.0')
  assert.match(digest.value, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(
    loaded.value.resolve('fs.read@0.1.0', { contentDigest: digest.value }),
    { ok: true, value: fsReadDefinition() },
  )
  assert.deepEqual(
    loaded.value.resolve('fs.read@0.1.0', {
      contentDigest: `sha256:${'0'.repeat(64)}`,
    }),
    {
      error: {
        actual: digest.value,
        code: 'schema-content-digest-mismatch',
        expected: `sha256:${'0'.repeat(64)}`,
        reference: 'fs.read@0.1.0',
      },
      ok: false,
    },
  )
})

test('REG-008 keeps operation cancellation contracts closed and digest-bound', () => {
  const cooperative = fsReadDefinition()
  cooperative.members.read_file.cancellation = 'cooperative'
  const completeBeforeJoin = fsReadDefinition()
  completeBeforeJoin.members.read_file.cancellation = 'complete-before-join'
  const base = SchemaRegistry.load([fsReadDefinition()])
  const first = SchemaRegistry.load([cooperative])
  const second = SchemaRegistry.load([completeBeforeJoin])

  assert.equal(base.ok, true)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.notEqual(
    base.value.contentDigest('fs.read@0.1.0').value,
    first.value.contentDigest('fs.read@0.1.0').value,
  )
  assert.notEqual(
    first.value.contentDigest('fs.read@0.1.0').value,
    second.value.contentDigest('fs.read@0.1.0').value,
  )
  assert.equal(
    second.value.resolve('fs.read@0.1.0').value.members.read_file.cancellation,
    'complete-before-join',
  )

  const invalid = fsReadDefinition()
  invalid.members.read_file.cancellation = 'detached'
  assert.deepEqual(SchemaRegistry.load([invalid]), {
    diagnostics: [{
      code: 'invalid-schema-definition',
      member: 'read_file',
      reason: 'invalid-cancellation-contract',
      reference: 'fs.read@0.1.0',
    }],
    ok: false,
  })
})

test('REG-009 keeps resource access constructors explicit and parameter-bound', () => {
  const unknownParameter = fsReadDefinition()
  unknownParameter.members.read_file.access = ['read fs.file(missing)']
  assert.deepEqual(SchemaRegistry.load([unknownParameter]), {
    diagnostics: [{
      code: 'invalid-schema-definition',
      member: 'read_file',
      parameter: 'missing',
      reason: 'unknown-resource-access-parameter',
      reference: 'fs.read@0.1.0',
    }],
    ok: false,
  })

  const malformed = fsReadDefinition()
  malformed.members.read_file.access = ['read fs.file(path']
  assert.deepEqual(SchemaRegistry.load([malformed]), {
    diagnostics: [{
      code: 'invalid-schema-definition',
      member: 'read_file',
      reason: 'invalid-resource-access-expression',
      reference: 'fs.read@0.1.0',
    }],
    ok: false,
  })

  const valid = fsReadDefinition()
  valid.members.read_file.access = ['read fs.file(path)', 'read fs.file(encoding)']
  assert.equal(SchemaRegistry.load([valid]).ok, true)
})

test('REG-010 normalizes access parameter spacing and rejects empty parameters', () => {
  const spaced = fsReadDefinition()
  spaced.members.read_file.access = ['read fs.file(path , encoding)']
  assert.equal(SchemaRegistry.load([spaced]).ok, true)

  for (const access of [
    'read fs.file(path,)',
    'read fs.file(,path)',
    'read fs.file(path,,encoding)',
  ]) {
    const invalid = fsReadDefinition()
    invalid.members.read_file.access = [access]
    assert.deepEqual(SchemaRegistry.load([invalid]), {
      diagnostics: [{
        code: 'invalid-schema-definition',
        member: 'read_file',
        reason: 'invalid-resource-access-expression',
        reference: 'fs.read@0.1.0',
      }],
      ok: false,
    })
  }
})

test('REG-011 binds equivalent access parameter spellings to one digest', () => {
  const compact = fsReadDefinition()
  compact.members.read_file.access = ['read fs.file(path,encoding)']
  const spaced = fsReadDefinition()
  spaced.members.read_file.access = ['read fs.file(path , encoding)']

  const compactLoaded = SchemaRegistry.load([compact])
  const spacedLoaded = SchemaRegistry.load([spaced])
  assert.equal(compactLoaded.ok, true)
  assert.equal(spacedLoaded.ok, true)
  assert.equal(
    compactLoaded.value.contentDigest('fs.read@0.1.0').value,
    spacedLoaded.value.contentDigest('fs.read@0.1.0').value,
  )
})

test('REG-012 requires explicit one-hop resource aliases and canonicalizes them', () => {
  const canonical = fsReadDefinition()
  const aliased = fsReadDefinition()
  aliased.resource_aliases = { file: 'fs.file' }
  aliased.members.read_file.access = ['read file(path)']

  const canonicalLoaded = SchemaRegistry.load([canonical])
  const aliasedLoaded = SchemaRegistry.load([aliased])
  assert.equal(canonicalLoaded.ok, true)
  assert.equal(aliasedLoaded.ok, true)
  assert.equal(
    canonicalLoaded.value.contentDigest('fs.read@0.1.0').value,
    aliasedLoaded.value.contentDigest('fs.read@0.1.0').value,
  )

  const chained = fsReadDefinition()
  chained.resource_aliases = { file: 'fs.file', input: 'file' }
  assert.deepEqual(SchemaRegistry.load([chained]), {
    diagnostics: [{
      alias: 'input',
      code: 'invalid-schema-definition',
      reference: 'fs.read@0.1.0',
      reason: 'resource-alias-chaining-not-allowed',
      target: 'file',
    }],
    ok: false,
  })

  const invalid = fsReadDefinition()
  invalid.resource_aliases = { 'FS.file': 'fs.file' }
  assert.deepEqual(SchemaRegistry.load([invalid]), {
    diagnostics: [{
      alias: 'FS.file',
      code: 'invalid-schema-definition',
      reference: 'fs.read@0.1.0',
      reason: 'invalid-resource-alias-name',
    }],
    ok: false,
  })
})

test('REG-013 validates explicit resource parents without implementing overlap', () => {
  const child = fsReadDefinition()
  child.resource_parents = { 'fs.file.row': 'fs.file' }
  const root = fsReadDefinition()
  root.resource_parents = { 'fs.file.row': 'fs' }

  const childLoaded = SchemaRegistry.load([child])
  const rootLoaded = SchemaRegistry.load([root])
  assert.equal(childLoaded.ok, true)
  assert.equal(rootLoaded.ok, true)
  assert.notEqual(
    childLoaded.value.contentDigest('fs.read@0.1.0').value,
    rootLoaded.value.contentDigest('fs.read@0.1.0').value,
  )

  const cycle = fsReadDefinition()
  cycle.resource_parents = { 'fs.file': 'fs.file.row', 'fs.file.row': 'fs.file' }
  assert.deepEqual(SchemaRegistry.load([cycle]), {
    diagnostics: [{
      children: ['fs.file', 'fs.file.row'],
      code: 'invalid-schema-definition',
      reference: 'fs.read@0.1.0',
      reason: 'resource-parent-cycle',
    }],
    ok: false,
  })

  const invalid = fsReadDefinition()
  invalid.resource_parents = { 'FS.file': 'fs' }
  assert.deepEqual(SchemaRegistry.load([invalid]), {
    diagnostics: [{
      child: 'FS.file',
      code: 'invalid-schema-definition',
      reference: 'fs.read@0.1.0',
      reason: 'invalid-resource-parent-name',
    }],
    ok: false,
  })
})

test('P0-07 instantiates only explicit typed resource catalog entries', () => {
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
  const loaded = SchemaRegistry.load([definition])
  assert.equal(loaded.ok, true)
  assert.deepEqual(
    loaded.value.resourceFootprint(
      'fs.read@0.1.0',
      'read_file',
      { path: 'tenant/input.txt' },
    ),
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

  const aliased = structuredClone(definition)
  aliased.resource_aliases = { file: 'fs.file' }
  aliased.members.read_file.access = ['read file(path)']
  const aliasedLoaded = SchemaRegistry.load([aliased])
  assert.equal(aliasedLoaded.ok, true)
  assert.deepEqual(
    aliasedLoaded.value.resourceFootprint(
      'fs.read@0.1.0',
      'read_file',
      { path: 'tenant/input.txt' },
    ),
    loaded.value.resourceFootprint(
      'fs.read@0.1.0',
      'read_file',
      { path: 'tenant/input.txt' },
    ),
  )

  assert.deepEqual(
    loaded.value.resourceFootprint(
      'fs.read@0.1.0',
      'read_file',
      { path: { dynamic: true } },
    ).value[0].resource.segments,
    null,
  )
})

test('P0-07 rejects malformed adapter-facing resource catalog declarations', () => {
  const invalid = fsReadDefinition()
  invalid.resource_catalog = {
    'fs.file': {
      domain_digest: 'not-a-digest',
      segments: [{ parameter: 'path', type_digest: 'not-a-digest' }],
    },
  }
  assert.deepEqual(SchemaRegistry.load([invalid]), {
    diagnostics: [{
      code: 'invalid-schema-definition',
      constructor: 'fs.file',
      reason: 'invalid-resource-catalog-entry',
      reference: 'fs.read@0.1.0',
    }],
    ok: false,
  })
})

test('P0-07 resolves explicit parent lineage after alias canonicalization', () => {
  const definition = fsReadDefinition()
  definition.resource_catalog = {
    'fs.file': {
      domain_digest: `sha256:${'a'.repeat(64)}`,
      segments: [{
        parameter: 'path',
        type_digest: `sha256:${'b'.repeat(64)}`,
      }],
    },
    'fs.storage': {
      domain_digest: `sha256:${'a'.repeat(64)}`,
      segments: [],
    },
  }
  definition.resource_aliases = { file: 'fs.file' }
  definition.resource_parents = { 'fs.file': 'fs.storage' }
  const loaded = SchemaRegistry.load([definition])
  assert.equal(loaded.ok, true)
  assert.deepEqual(
    loaded.value.resourceLineage('fs.read@0.1.0', 'file'),
    { ok: true, value: ['fs.file', 'fs.storage'] },
  )
})

test('P0-07 requires catalog entries for instantiated parent constructors', () => {
  const invalid = fsReadDefinition()
  invalid.resource_catalog = {
    'fs.file': {
      domain_digest: `sha256:${'a'.repeat(64)}`,
      segments: [{
        parameter: 'path',
        type_digest: `sha256:${'b'.repeat(64)}`,
      }],
    },
  }
  invalid.resource_parents = { 'fs.file': 'fs.storage' }
  assert.deepEqual(SchemaRegistry.load([invalid]), {
    diagnostics: [{
      code: 'invalid-schema-definition',
      parent: 'fs.storage',
      reason: 'resource-parent-constructor-not-declared',
      reference: 'fs.read@0.1.0',
    }],
    ok: false,
  })
})

test('REG-005 does not fall back to another schema revision', () => {
  const newer = fsReadDefinition()
  newer.revision = '0.2.0'
  const loaded = SchemaRegistry.load([newer])

  assert.equal(loaded.ok, true)
  assert.deepEqual(loaded.value.resolve('fs.read@0.1.0'), {
    ok: false,
    error: {
      code: 'missing-schema-revision',
      reference: 'fs.read@0.1.0',
    },
  })
})

test('REG-004 rejects conflicting definitions atomically', () => {
  const conflicting = fsReadDefinition()
  conflicting.members.read_file.returns = 'result<bytes, fs.read_error>'

  const loaded = SchemaRegistry.load([fsReadDefinition(), conflicting])

  assert.deepEqual(loaded, {
    ok: false,
    diagnostics: [
      {
        code: 'schema-revision-conflict',
        reference: 'fs.read@0.1.0',
      },
    ],
  })
  assert.equal('value' in loaded, false)
})

test('REG-006 rejects a member with more than one primary parameter', () => {
  const invalid = fsReadDefinition()
  invalid.members.read_file.params[1].primary = true

  const loaded = SchemaRegistry.load([invalid])

  assert.deepEqual(loaded, {
    ok: false,
    diagnostics: [
      {
        code: 'invalid-schema-definition',
        member: 'read_file',
        reason: 'multiple-primary-parameters',
        reference: 'fs.read@0.1.0',
      },
    ],
  })
})

test('registry rejects a result whose error sum is not defined', () => {
  const invalid = fsReadDefinition()
  delete invalid.types['fs.read_error']

  assert.deepEqual(SchemaRegistry.load([invalid]), {
    ok: false,
    diagnostics: [
      {
        code: 'invalid-schema-definition',
        member: 'read_file',
        reason: 'missing-error-type-definition',
        reference: 'fs.read@0.1.0',
        type: 'fs.read_error',
      },
    ],
  })
})

test('registry rejects duplicate variants in a closed error sum', () => {
  const invalid = fsReadDefinition()
  invalid.types['fs.read_error'].variants.push('not_found')

  assert.deepEqual(SchemaRegistry.load([invalid]), {
    ok: false,
    diagnostics: [
      {
        code: 'invalid-schema-definition',
        reason: 'duplicate-error-variant',
        reference: 'fs.read@0.1.0',
        type: 'fs.read_error',
        variant: 'not_found',
      },
    ],
  })
})

test('registry rejects an empty closed error sum', () => {
  const invalid = fsReadDefinition()
  invalid.types['fs.read_error'].variants = []

  assert.deepEqual(SchemaRegistry.load([invalid]), {
    ok: false,
    diagnostics: [
      {
        code: 'invalid-schema-definition',
        reason: 'empty-error-sum',
        reference: 'fs.read@0.1.0',
        type: 'fs.read_error',
      },
    ],
  })
})

test('registry rejects malformed error sum variants without throwing', () => {
  const invalid = fsReadDefinition()
  invalid.types['fs.read_error'].variants = 'not_found'

  assert.deepEqual(SchemaRegistry.load([invalid]), {
    ok: false,
    diagnostics: [
      {
        code: 'invalid-schema-definition',
        reason: 'invalid-error-sum-variants',
        reference: 'fs.read@0.1.0',
        type: 'fs.read_error',
      },
    ],
  })
})

test('REG-002 deduplicates byte-identical definitions', () => {
  const loaded = SchemaRegistry.load([
    fsReadDefinition(),
    structuredClone(fsReadDefinition()),
  ])

  assert.equal(loaded.ok, true)
  assert.deepEqual(
    loaded.value.resolve('fs.read@0.1.0').value,
    fsReadDefinition(),
  )
})

test('REG-002 canonicalizes name-indexed parameters before deduplication', () => {
  const reordered = fsReadDefinition()
  reordered.members.read_file.params.reverse()

  const loaded = SchemaRegistry.load([fsReadDefinition(), reordered])

  assert.equal(loaded.ok, true)
  assert.equal(loaded.value.resolve('fs.read@0.1.0').ok, true)
})

test('REG-002 canonicalizes closed error variants before deduplication', () => {
  const reordered = fsReadDefinition()
  reordered.types['fs.read_error'].variants.reverse()

  const loaded = SchemaRegistry.load([fsReadDefinition(), reordered])

  assert.equal(loaded.ok, true)
  assert.equal(loaded.value.resolve('fs.read@0.1.0').ok, true)
})

test('REG-003 produces the same resolutions regardless of load order', () => {
  const forward = SchemaRegistry.load([
    fsReadDefinition(),
    stdoutDefinition(),
  ]).value
  const reverse = SchemaRegistry.load([
    stdoutDefinition(),
    fsReadDefinition(),
  ]).value

  for (const reference of ['fs.read@0.1.0', 'process.stdout@0.1.0']) {
    assert.deepEqual(forward.resolve(reference), reverse.resolve(reference))
  }
})

test('REG-001 loads all four built-in Demo capability interfaces', () => {
  const loaded = SchemaRegistry.load(demoSchemaDefinitions())

  assert.equal(loaded.ok, true)
  for (const reference of [
    'process.args@0.1.0',
    'fs.read@0.1.0',
    'fs.write@0.1.0',
    'process.stdout@0.1.0',
  ]) {
    assert.equal(loaded.value.resolve(reference).ok, true)
  }
})

test('loaded schema definitions cannot drift through caller mutation', () => {
  const definition = fsReadDefinition()
  const registry = SchemaRegistry.load([definition]).value

  definition.members.read_file.returns = 'result<bytes, fs.read_error>'

  assert.equal(
    registry.resolve('fs.read@0.1.0').value.members.read_file.returns,
    'result<text.utf8, fs.read_error>',
  )
})
