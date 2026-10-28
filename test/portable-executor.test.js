import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import {
  PORTABLE_EXECUTION_RESULT_SCHEMA,
  PORTABLE_EXECUTOR_CONTRACT_SCHEMA,
  executePortableProgram,
  executePortableProgramContract,
  validatePortableExecutorContract,
  verifyPortableExecutionResult,
} from '../src/toolchain/portable-executor.js'
import { runSource, checkSource } from '../src/toolchain/demo-toolchain.js'

const hello = await readFile(new URL('../examples/hello.re', import.meta.url), 'utf8')
const revision = `sha256:${'a'.repeat(64)}`

test('portable executor core has no Node builtin imports and matches Node reference outcome', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  assert.equal(checked.ok, true)

  const stdout = []
  const portable = executePortableProgram(checked.program, {
    invokeCapability(instance, member, args) {
      if (instance !== '@stdout' || member !== 'write') {
        return {
          diagnostics: [{ code: 'portable-test-unknown-capability' }],
          kind: 'check-failure',
        }
      }
      stdout.push(args.data)
      return { kind: 'value', value: { kind: 'ok', value: null } }
    },
  })
  const reference = runSource(hello, { file: 'hello.re' })

  assert.deepEqual(portable, { code: 0, type: 'process.status' })
  assert.deepEqual(reference, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: 'Hello, World!\n',
  })
  assert.deepEqual(stdout, [reference.programStdout])
})

test('portable execution contract binds graph revision, profile and input digest', () => {
  const contract = {
    executor: 'portable-core',
    graph_revision: revision,
    input_digest: revision,
    profile: 're.portable-reference@0.1.0',
    schema: PORTABLE_EXECUTOR_CONTRACT_SCHEMA,
  }
  assert.deepEqual(validatePortableExecutorContract(contract), { ok: true })

  const checked = checkSource(hello, { file: 'hello.re' })
  assert.equal(checked.ok, true)
  const result = executePortableProgramContract({
    contract,
    graph: { ...checked.program, graph_revision: revision },
    invokeCapability() {
      return { kind: 'value', value: { kind: 'ok', value: null } }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(Object.isFrozen(result.verification_evidence), true)
  assert.equal(Object.isFrozen(contract), false)
  assert.deepEqual(
    verifyPortableExecutionResult(result.value, contract, {
      evidence: { ...result.verification_evidence },
      graph: { ...checked.program, graph_revision: revision },
    }),
    {
      diagnostics: [{ code: 'portable-execution-verification-evidence-missing' }],
      ok: false,
    },
  )
  assert.equal(result.value.schema, PORTABLE_EXECUTION_RESULT_SCHEMA)
  assert.equal(result.value.contract.graph_revision, revision)
  assert.deepEqual(result.value.outcome, { code: 0, type: 'process.status' })
  assert.deepEqual(result.value.receipt, {
    executor: 'portable-core',
    graph_revision: revision,
    input_digest: revision,
    invocations: [{
      instance: '@stdout',
      invocation_id: checked.program.functions[0].statements[0].uid,
      member: 'write',
      outcome: 'ok',
    }],
    outcome: { code: 0, type: 'process.status' },
    profile: 're.portable-reference@0.1.0',
    schema: 're.portable-execution-receipt@0.1.0',
  })
  const graph = { ...checked.program, graph_revision: revision }
  assert.deepEqual(
    verifyPortableExecutionResult(result.value, contract, {
      evidence: result.verification_evidence,
      graph,
    }),
    { ok: true },
  )

  assert.deepEqual(verifyPortableExecutionResult(result.value, contract, {
    graph,
  }), {
    diagnostics: [{ code: 'portable-execution-verification-evidence-missing' }],
    ok: false,
  })

  const changed = structuredClone(result.value)
  changed.receipt.outcome.code = 1
  assert.deepEqual(verifyPortableExecutionResult(changed, contract, {
    evidence: result.verification_evidence,
    graph,
  }), {
    diagnostics: [{ code: 'portable-execution-receipt-outcome-mismatch' }],
    ok: false,
  })

  const changedResult = structuredClone(result.value)
  changedResult.outcome.code = 1
  assert.deepEqual(verifyPortableExecutionResult(changedResult, contract, {
    evidence: result.verification_evidence,
    graph,
  }), {
    diagnostics: [{ code: 'portable-execution-receipt-outcome-mismatch' }],
    ok: false,
  })

  const selfConsistent = structuredClone(result.value)
  selfConsistent.outcome.code = 1
  selfConsistent.receipt.outcome.code = 1
  assert.deepEqual(
    verifyPortableExecutionResult(selfConsistent, contract, {
      evidence: result.verification_evidence,
      graph,
    }),
    {
      diagnostics: [{
        code: 'portable-execution-evidence-outcome-mismatch',
      }],
      ok: false,
    },
  )

  const resigned = structuredClone(result.value)
  resigned.receipt.invocations[0].outcome = 'err'
  resigned.outcome.code = 1
  resigned.receipt.outcome.code = 1
  assert.deepEqual(
    verifyPortableExecutionResult(resigned, contract, {
      evidence: result.verification_evidence,
      graph,
    }),
    {
      diagnostics: [
        { code: 'portable-execution-evidence-invocations-mismatch' },
        { code: 'portable-execution-evidence-outcome-mismatch' },
      ],
      ok: false,
    },
  )
})

test('portable verification evidence snapshots full capability response and arguments', () => {
  const contract = {
    executor: 'portable-core',
    graph_revision: revision,
    input_digest: revision,
    profile: 're.portable-reference@0.1.0',
    schema: PORTABLE_EXECUTOR_CONTRACT_SCHEMA,
  }
  const checked = checkSource(hello, { file: 'hello.re' })
  assert.equal(checked.ok, true)
  const response = {
    kind: 'value',
    value: {
      kind: 'ok',
      value: { marker: 'original' },
    },
  }
  const result = executePortableProgramContract({
    contract,
    graph: { ...checked.program, graph_revision: revision },
    invokeCapability() {
      return response
    },
  })
  assert.equal(result.ok, true)
  response.value.kind = 'err'
  response.value.value.marker = 'mutated'

  const graph = { ...checked.program, graph_revision: revision }
  assert.deepEqual(
    verifyPortableExecutionResult(result.value, contract, {
      evidence: result.verification_evidence,
      graph,
    }),
    { ok: true },
  )

  const changedGraph = structuredClone(graph)
  changedGraph.functions[0].literals.find(
    ({ value }) => value === 'Hello, World!\n',
  ).value = 'Tampered\n'
  assert.deepEqual(
    verifyPortableExecutionResult(result.value, contract, {
      evidence: result.verification_evidence,
      graph: changedGraph,
    }),
    {
      diagnostics: [{
        code: 'portable-execution-replay-invocation-arguments-mismatch',
      }],
      ok: false,
    },
  )
})

test('portable execution consumes one capability response snapshot', () => {
  const contract = {
    executor: 'portable-core',
    graph_revision: revision,
    input_digest: revision,
    profile: 're.portable-reference@0.1.0',
    schema: PORTABLE_EXECUTOR_CONTRACT_SCHEMA,
  }
  const checked = checkSource(hello, { file: 'hello.re' })
  assert.equal(checked.ok, true)
  let reads = 0
  const response = {
    kind: 'value',
    get value() {
      reads += 1
      return reads === 1
        ? { kind: 'ok', value: null }
        : { kind: 'err', value: null }
    },
  }
  const graph = { ...checked.program, graph_revision: revision }
  const result = executePortableProgramContract({
    contract,
    graph,
    invokeCapability() {
      return response
    },
  })

  assert.equal(result.ok, true)
  assert.equal(reads, 1)
  assert.equal(Object.isFrozen(response), false)
  assert.deepEqual(result.value.outcome, { code: 0, type: 'process.status' })
  assert.equal(result.value.receipt.invocations[0].outcome, 'ok')
  assert.deepEqual(
    verifyPortableExecutionResult(result.value, contract, {
      evidence: result.verification_evidence,
      graph,
    }),
    { ok: true },
  )
})

test('portable evidence rejects spoofed Uint8Array capability payloads', () => {
  const contract = {
    executor: 'portable-core',
    graph_revision: revision,
    input_digest: revision,
    profile: 're.portable-reference@0.1.0',
    schema: PORTABLE_EXECUTOR_CONTRACT_SCHEMA,
  }
  const checked = checkSource(hello, { file: 'hello.re' })
  assert.equal(checked.ok, true)
  const bytes = new Proxy(new Uint8Array([0x11, 0x22]), {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        return function* spoofedBytes() {
          yield 0x33
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })

  assert.deepEqual(
    executePortableProgramContract({
      contract,
      graph: { ...checked.program, graph_revision: revision },
      invokeCapability() {
        return {
          kind: 'value',
          value: {
            kind: 'ok',
            value: { bytes },
          },
        }
      },
    }),
    {
      diagnostics: [{
        code: 'portable-executor-capability-fault',
        instance: '@stdout',
        member: 'write',
      }],
      ok: false,
    },
  )
})

test('portable executor rejects contract drift, unsupported effects and missing match branches', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  assert.equal(checked.ok, true)

  const drift = executePortableProgramContract({
    contract: {
      executor: 'portable-core',
      graph_revision: `sha256:${'b'.repeat(64)}`,
      input_digest: revision,
      profile: 're.portable-reference@0.1.0',
      schema: PORTABLE_EXECUTOR_CONTRACT_SCHEMA,
    },
    graph: { ...checked.program, graph_revision: revision },
    invokeCapability() {
      return { kind: 'value', value: { kind: 'ok', value: null } }
    },
  })
  assert.deepEqual(drift, {
    diagnostics: [{ code: 'portable-executor-graph-revision-mismatch' }],
    ok: false,
  })

  const unsupported = structuredClone(checked.program)
  unsupported.functions[0].statements[0].value.target = {
    kind: 'pure-operation',
    operation: 'future.operation',
    schemaReference: 'future@0.1.0',
  }
  assert.deepEqual(
    executePortableProgram(unsupported, { invokeCapability() {} }),
    {
      diagnostics: [{ code: 'portable-executor-unsupported-pure-operation' }],
      kind: 'check-failure',
    },
  )

  const missingBranch = structuredClone(checked.program)
  missingBranch.functions[0].statements[1].value.branches =
    missingBranch.functions[0].statements[1].value.branches.filter(
      ({ variant }) => variant !== 'ok',
    )
  assert.deepEqual(
    executePortableProgram(missingBranch, {
      invokeCapability() {
        return { kind: 'value', value: { kind: 'ok', value: null } }
      },
    }),
    {
      diagnostics: [{ code: 'portable-executor-missing-match-branch', variant: 'ok' }],
      kind: 'check-failure',
    },
  )
})

test('portable core source imports no Node builtin or host adapter module', async () => {
  const source = await readFile(
    new URL('../src/toolchain/portable-executor.js', import.meta.url),
    'utf8',
  )
  assert.equal(source.includes("from 'node:"), false)
  assert.equal(source.includes('from "../host/'), false)
  assert.equal(source.includes("from '../host/"), false)
})
