import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { lowerModuleSurface } from '../src/toolchain/module-surface.js'

const manifest = JSON.parse(await readFile(
  new URL('./fixtures/module-contract-corpus.json', import.meta.url),
  'utf8',
)).manifest
const interfaceDigest = 'sha256:6cbfa0a9e364b386c5f6015b90a3bc4d962062b4ba553ad25e43f0bcf03fe71c'
const logDigest = 'sha256:7c1db8f3affe2264d5e0dfec3045aad064e881ab78c2b1f86b817895154050aa'

test('module execution declarations lower validated task, adapter, and run case contracts', () => {
  const declarations = executionDeclarations()
  const first = lowerModuleSurface(source(declarations), manifest)
  const reordered = lowerModuleSurface(source([...declarations].reverse()), manifest)

  assert.equal(first.ok, true, JSON.stringify(first.diagnostics))
  assert.deepEqual(reordered, first)
  assert.equal(first.value.schema, 're.module-surface-lowering@0.3.0')
  assert.equal(first.value.task_contracts[0].name, 'agent.relay.api.task')
  assert.match(first.value.task_contracts[0].contract_digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(first.value.adapter_contracts[0].name, 'agent.relay.api.log')
  assert.match(first.value.adapter_contracts[0].contract_digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(first.value.run_cases[0].name, 'agent.relay.api.default')
})

test('module execution declarations reject noncanonical and detached contracts', () => {
  const noncanonicalJson = canonical(taskContract()).replace('{', '{ ')
  const noncanonical = lowerModuleSurface(source([
    `task-contract agent.relay.api.task ${noncanonicalJson}`,
  ]), manifest)
  assert.equal(noncanonical.ok, false)
  assert.equal(noncanonical.diagnostics[0].code, 'noncanonical-module-execution-json')

  const detached = taskContract()
  detached.module = 'agent.relay.service'
  const result = lowerModuleSurface(source([
    `task-contract agent.relay.api.task ${canonical(detached)}`,
  ]), manifest)
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'module-execution-contract-detached')
})

test('module execution declarations reject duplicate semantic names', () => {
  const declaration = `task-contract agent.relay.api.task ${canonical(taskContract())}`
  const result = lowerModuleSurface(source([declaration, declaration]), manifest)

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'duplicate-module-execution-declaration')
})

function executionDeclarations() {
  return [
    `task-contract agent.relay.api.task ${canonical(taskContract())}`,
    `adapter-contract agent.relay.api.log ${canonical(adapterContract())}`,
    `run-case agent.relay.api.default ${canonical(runCase())}`,
  ]
}

function taskContract() {
  return {
    agent: 'agent.relay.api',
    backoff_ms: [0],
    checkpoint: {
      fields: ['attempt', 'input_digest', 'revision'],
      revision_field: 'revision',
      schema: 're.task-checkpoint@0.1.0',
    },
    error_type: { kind: 'type', name: 'agent.relay.api.error' },
    input_type: { kind: 'type', name: 'agent.relay.api.input' },
    max_attempts: 2,
    module: 'agent.relay.api',
    node_uid: uid('a'),
    output_type: { kind: 'type', name: 'agent.relay.api.output' },
    retryable_errors: ['transient'],
    schema: 're.task-contract@0.1.0',
  }
}

function adapterContract() {
  return {
    agent: 'agent.relay.api',
    capability: {
      instance: '@log',
      member: 'write',
      reference: 'log.write@0.1.0',
    },
    cancellation: { mode: 'cooperative', supported: true },
    deadline: { max_ms: 0, required: false },
    error_type: { kind: 'type', name: 'agent.relay.api.adapter_error' },
    error_variants: ['transient', 'unavailable'],
    features: ['cancellation'],
    input_type: { kind: 'type', name: 'agent.relay.api.input' },
    module: 'agent.relay.api',
    node_uid: uid('a'),
    output_type: { kind: 'type', name: 'agent.relay.api.output' },
    profile: {
      digest: digest('a'),
      id: 'server-minimum@0.1.0',
      schema: 're.server-profile@0.1.0',
    },
    request_type: { kind: 'type', name: 'agent.relay.api.input' },
    resource: { access: 'write', constructor: 'log' },
    schema: 're.agent-adapter-contract@0.1.0',
  }
}

function runCase() {
  return {
    adapter: 'agent.relay.api.log',
    request: {
      agent: 'agent.relay.api',
      idempotency_key: 'relay-001',
      input: { message: 'hello' },
      module: 'agent.relay.api',
      node_uid: uid('a'),
    },
    responses: [{
      input: { attempt: 1, message: 'hello' },
      outcome: { kind: 'value', value: { kind: 'ok', value: { written: true } } },
    }],
    schema: 're.project-run-case@0.1.0',
    task: 'agent.relay.api.task',
  }
}

function source(declarations) {
  return [
    're 1.0 compact',
    'module agent.relay.api',
    `import agent.relay.service@${interfaceDigest} as service`,
    `import external std.log@${logDigest} from ${digest('8')} as log`,
    'export serve',
    `capability agent.relay.api.log write log.write@0.1.0 uid ${uid('a')}`,
    ...declarations,
    '',
  ].join('\n')
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function uid(character) {
  return `${character.repeat(25)}e`
}

function digest(character) {
  return `sha256:${character.repeat(64)}`
}
