import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  invokeAgentCapability,
  validateAgentAdapterContract,
} from '../src/host/agent-adapter-contract.js'
import { AgentHttpAdapter } from '../src/host/agent-http-adapter.js'
import {
  AgentMemoryAdapter,
  agentMemoryResponseKey,
} from '../src/host/agent-memory-adapter.js'
import { buildServerProfile } from '../src/host/server-profile.js'

const corpus = JSON.parse(
  await readFile(new URL('./fixtures/agent-adapter-corpus.json', import.meta.url), 'utf8'),
)
const builtProfile = buildServerProfile().value
const profile = {
  digest: builtProfile.profile_digest,
  id: builtProfile.id,
  schema: builtProfile.schema,
}
const input = {
  body: new Uint8Array(),
  deadline: 1000,
  headers: '',
  method: 'GET',
  redirect_policy: 'follow',
  url: 'https://example.test/',
}

function call(overrides = {}) {
  return {
    capability_reference: 'http.client@0.1.0',
    cancellation: null,
    deadline: 1000,
    input,
    member: 'request',
    request_id: 'agent-request-1',
    ...overrides,
  }
}

test('Agent adapter contract is versioned, typed, and profile-pinned', () => {
  const first = validateAgentAdapterContract(corpus.contract)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.value.schema, 're.agent-adapter-contract@0.1.0')
  assert.deepEqual(first.value.features, ['cancellation', 'deadline'])
  const reordered = structuredClone(corpus.contract)
  reordered.features.reverse()
  reordered.error_variants.reverse()
  assert.deepEqual(validateAgentAdapterContract(reordered), first)
})

test('memory and HTTP adapters share typed outcomes through one Agent front door', async () => {
  const response = {
    kind: 'value',
    value: { kind: 'ok', value: '{"status":200}' },
  }
  const memory = new AgentMemoryAdapter({
    contract: corpus.contract,
    profile,
    responses: new Map([[agentMemoryResponseKey(input), response]]),
  })
  assert.deepEqual(
    invokeAgentCapability(corpus.contract, memory, call()),
    {
      ok: true,
      value: {
        outcome: { kind: 'ok', value: '{"status":200}' },
        request_id: 'agent-request-1',
        schema: 're.agent-adapter-outcome@0.1.0',
      },
    },
  )

  let observed = null
  const http = new AgentHttpAdapter({
    contract: corpus.contract,
    profile,
    transport: (request) => {
      observed = request
      return '{"status":200}'
    },
  })
  const result = await invokeAgentCapability(corpus.contract, http, call({
    request_id: 'agent-http-1',
  }))
  assert.deepEqual(result.value.outcome, {
    kind: 'ok',
    value: '{"status":200}',
  })
  assert.equal(observed.url, input.url)
  assert.deepEqual(observed.body, new Uint8Array())
  const cancelled = invokeAgentCapability(corpus.contract, memory, call({
    cancellation: 'requested',
    request_id: 'agent-cancel-1',
  }))
  assert.deepEqual(cancelled.value.outcome, { kind: 'cancelled' })
})

test('Agent adapter rejects stale profile, deadline, cancellation, and extra fields before dispatch', () => {
  let calls = 0
  const adapter = {
    profileIdentity: () => profile,
    invoke: () => {
      calls += 1
      return { kind: 'value', value: { kind: 'ok', value: 'bad' } }
    },
  }
  const staleProfile = structuredClone(corpus.contract)
  staleProfile.profile.digest = `sha256:${'0'.repeat(64)}`
  assert.equal(
    invokeAgentCapability(staleProfile, adapter, call()).diagnostics[0].code,
    'agent-profile-identity-mismatch',
  )
  assert.equal(
    invokeAgentCapability(corpus.contract, adapter, call({ deadline: 10001 }))
      .diagnostics[0].code,
    'invalid-agent-deadline',
  )
  assert.equal(
    invokeAgentCapability(corpus.contract, adapter, call({ cancellation: 'requested' }))
      .value.outcome.kind,
    'ok',
  )
  const extra = call()
  extra.secret = 'must-not-cross-contract'
  assert.equal(
    invokeAgentCapability(corpus.contract, adapter, extra).diagnostics[0].code,
    'unexpected-agent-adapter-call-field',
  )
  assert.equal(calls, 1)
})

test('Agent adapter sanitizes malformed results, undeclared errors, and host exceptions', () => {
  const base = {
    profileIdentity: () => profile,
  }
  const malformed = invokeAgentCapability(corpus.contract, {
    ...base,
    invoke: () => ({ kind: 'value', value: { kind: 'ok', value: 'x', extra: true } }),
  }, call())
  assert.equal(malformed.value.outcome.kind, 'host-fault')
  assert.equal(malformed.value.fault.reason, 'malformed-adapter-outcome')

  const undeclared = invokeAgentCapability(corpus.contract, {
    ...base,
    invoke: () => ({
      kind: 'value',
      value: {
        error: { type: 'http.client_error', variant: 'secret_leak' },
        kind: 'err',
      },
    }),
  }, call())
  assert.equal(undeclared.value.fault.reason, 'undeclared-error-variant')

  const thrown = invokeAgentCapability(corpus.contract, {
    ...base,
    invoke: () => { throw new Error('raw host secret') },
  }, call())
  assert.equal(thrown.value.fault.reason, 'adapter-panicked')
  assert.equal(JSON.stringify(thrown).includes('raw host secret'), false)
})
