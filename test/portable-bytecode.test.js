import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { checkSource } from '../src/toolchain/demo-toolchain.js'
import {
  executePortableProgramContract,
} from '../src/toolchain/portable-executor.js'

let bytecodeApi
try {
  bytecodeApi = await import('../src/toolchain/portable-bytecode.js')
} catch {
  bytecodeApi = null
}

const bundle = JSON.parse(await readFile(
  new URL('./fixtures/portable-conformance.json', import.meta.url),
  'utf8',
))

test('portable bytecode compiles deterministically and executes the frozen slice', async () => {
  assert.notEqual(bytecodeApi, null)

  const entry = bundle.cases[0]
  const graph = await loadGraph(entry)
  const first = bytecodeApi.compilePortableBytecode(graph)
  const second = bytecodeApi.compilePortableBytecode(structuredClone(graph))

  assert.equal(first.ok, true)
  assert.deepEqual(second, first)
  assert.deepEqual(
    bytecodeApi.validatePortableBytecodeArtifact(first.value),
    { ok: true },
  )

  const execution = bytecodeApi.executePortableBytecode({
    artifact: first.value,
    checkedGraph: graph,
    expectedArtifactDigest: first.value.artifact_digest,
    expectedGraphRevision: entry.graph_revision,
    invokeCapability(instance, member, args, invocationId) {
      const expected = entry.invocations[0]
      assert.equal(instance, expected.instance)
      assert.equal(member, expected.member)
      assert.equal(invocationId, expected.invocation_id)
      assert.deepEqual(args, decodeValue(expected.arguments))
      return decodeValue(expected.response)
    },
  })

  assert.equal(execution.ok, true)
  assert.deepEqual(execution.value.outcome, decodeValue(entry.expected.outcome))
  assert.deepEqual(
    execution.value.invocations,
    decodeValue(entry.expected.receipt.invocations),
  )
})

test('portable bytecode rejects artifact, graph, profile, opcode, jump, register and literal drift', async () => {
  assert.notEqual(bytecodeApi, null)

  const graph = await loadGraph(bundle.cases[0])
  const compiled = bytecodeApi.compilePortableBytecode(graph)
  assert.equal(compiled.ok, true)

  for (const [label, mutate, code, refresh = true] of [
    [
      'artifact digest',
      (artifact) => { artifact.artifact_digest = digest('f') },
      'portable-bytecode-artifact-digest-mismatch',
      false,
    ],
    [
      'graph revision',
      (artifact) => { artifact.graph_revision = digest('e') },
      'portable-bytecode-graph-revision-mismatch',
    ],
    [
      'profile',
      (artifact) => { artifact.profile = 're.portable-bytecode@9.9.9' },
      'portable-bytecode-profile-mismatch',
    ],
    [
      'opcode',
      (artifact) => { artifact.instructions[0].op = 'eval-source' },
      'portable-bytecode-opcode-invalid',
    ],
    [
      'jump',
      (artifact) => { artifact.instructions[1].ok = 999 },
      'portable-bytecode-jump-invalid',
    ],
    [
      'register',
      (artifact) => { artifact.instructions[1].source = 999 },
      'portable-bytecode-register-invalid',
    ],
    [
      'literal',
      (artifact) => { artifact.instructions[2].code_literal = 999 },
      'portable-bytecode-literal-invalid',
    ],
  ]) {
    const changed = structuredClone(compiled.value)
    mutate(changed)
    if (refresh) {
      changed.artifact_digest =
        bytecodeApi.portableBytecodeArtifactDigest(changed)
    }
    const result = bytecodeApi.executePortableBytecode({
      artifact: changed,
      checkedGraph: graph,
      expectedArtifactDigest: changed.artifact_digest,
      expectedGraphRevision: graph.graph_revision,
      invokeCapability() {
        throw new Error('invalid artifact must not invoke host capability')
      },
    })
    assert.equal(result.ok, false, label)
    assert.ok(result.diagnostics.some(
      (diagnostic) => diagnostic.code === code,
    ), label)
  }

  for (const [label, mutate] of [
    [
      'literal content',
      (artifact) => { artifact.literals[0].value = 'changed.txt' },
    ],
    [
      'argument binding',
      (artifact) => {
        artifact.instructions[0].arguments[0].literal =
          artifact.instructions[2].code_literal
      },
    ],
  ]) {
    const changed = structuredClone(compiled.value)
    mutate(changed)
    changed.artifact_digest =
      bytecodeApi.portableBytecodeArtifactDigest(changed)
    const result = bytecodeApi.executePortableBytecode({
      artifact: changed,
      checkedGraph: graph,
      expectedArtifactDigest: changed.artifact_digest,
      expectedGraphRevision: graph.graph_revision,
      invokeCapability() {
        throw new Error('drifted artifact must not invoke host capability')
      },
    })
    assert.deepEqual(result, {
      diagnostics: [{
        code: 'portable-bytecode-checked-graph-artifact-mismatch',
      }],
      ok: false,
    }, label)
  }
})

test('portable bytecode compiler rejects graph shape expansion', async () => {
  assert.notEqual(bytecodeApi, null)

  const graph = await loadGraph(bundle.cases[0])
  const extraStatement = structuredClone(graph)
  extraStatement.functions[0].statements.push(
    structuredClone(extraStatement.functions[0].statements[0]),
  )
  const extraFunction = structuredClone(graph)
  extraFunction.functions.push(structuredClone(extraFunction.functions[0]))

  assert.deepEqual(bytecodeApi.compilePortableBytecode(extraStatement), {
    diagnostics: [{ code: 'portable-bytecode-main-invalid' }],
    ok: false,
  })
  assert.deepEqual(bytecodeApi.compilePortableBytecode(extraFunction), {
    diagnostics: [{ code: 'portable-bytecode-shape-unsupported' }],
    ok: false,
  })
})

test('portable bytecode matches portable core across the nine-case oracle', async () => {
  assert.notEqual(bytecodeApi, null)

  for (const entry of bundle.cases) {
    const graph = await loadGraph(entry)
    const bytecode = bytecodeApi.compilePortableBytecode(graph)
    assert.equal(bytecode.ok, true, entry.id)

    const portable = executePortableProgramContract({
      contract: entry.contract,
      graph,
      invokeCapability: scriptedCapability(entry),
    })
    const interpreted = bytecodeApi.executePortableBytecode({
      artifact: bytecode.value,
      checkedGraph: graph,
      expectedArtifactDigest: bytecode.value.artifact_digest,
      expectedGraphRevision: entry.graph_revision,
      invokeCapability: scriptedCapability(entry),
    })

    assert.equal(portable.ok, true, entry.id)
    assert.equal(interpreted.ok, true, entry.id)
    assert.deepEqual(
      interpreted.value.outcome,
      portable.value.outcome,
      entry.id,
    )
    assert.deepEqual(
      interpreted.value.invocations,
      portable.value.receipt.invocations,
      entry.id,
    )
  }
})

test('portable bytecode rederives artifact authority from the trusted checked graph', async () => {
  assert.notEqual(bytecodeApi, null)

  const graph = await loadGraph(bundle.cases[0])
  const compiled = bytecodeApi.compilePortableBytecode(graph)
  assert.equal(compiled.ok, true)

  const missingGraph = bytecodeApi.executePortableBytecode({
    artifact: compiled.value,
    expectedArtifactDigest: compiled.value.artifact_digest,
    expectedGraphRevision: graph.graph_revision,
    invokeCapability() {
      throw new Error('missing graph must not invoke host capability')
    },
  })
  assert.deepEqual(missingGraph, {
    diagnostics: [{ code: 'portable-bytecode-checked-graph-missing' }],
    ok: false,
  })

  for (const [label, mutate] of [
    [
      'literal content',
      (artifact) => { artifact.literals[0].value = 'changed.txt' },
    ],
    [
      'argument binding',
      (artifact) => {
        artifact.instructions[0].arguments[0].literal =
          artifact.instructions[2].code_literal
      },
    ],
    [
      'opcode',
      (artifact) => { artifact.instructions[0].op = 'invoke-source' },
    ],
    [
      'jump',
      (artifact) => { artifact.instructions[1].ok = 999 },
    ],
    [
      'register',
      (artifact) => { artifact.instructions[1].source = 999 },
    ],
  ]) {
    const changed = structuredClone(compiled.value)
    mutate(changed)
    changed.artifact_digest =
      bytecodeApi.portableBytecodeArtifactDigest(changed)
    let calls = 0
    const result = bytecodeApi.executePortableBytecode({
      artifact: changed,
      checkedGraph: graph,
      expectedArtifactDigest: changed.artifact_digest,
      expectedGraphRevision: graph.graph_revision,
      invokeCapability() {
        calls += 1
        throw new Error('drifted artifact must not invoke host capability')
      },
    })
    assert.equal(result.ok, false, label)
    assert.equal(calls, 0, label)
  }

  const graphDrift = structuredClone(graph)
  graphDrift.functions[0].literals[0].value = 'changed.txt'
  graphDrift.graph_revision = digest('d')
  const graphResult = bytecodeApi.executePortableBytecode({
    artifact: compiled.value,
    checkedGraph: graphDrift,
    expectedArtifactDigest: compiled.value.artifact_digest,
    expectedGraphRevision: graphDrift.graph_revision,
    invokeCapability() {
      throw new Error('drifted graph must not invoke host capability')
    },
  })
  assert.deepEqual(graphResult, {
    diagnostics: [{ code: 'portable-bytecode-graph-revision-mismatch' }],
    ok: false,
  })
})

test('portable bytecode interpreter core imports no Node builtin or host adapter', async () => {
  const source = await readFile(
    new URL('../src/toolchain/portable-bytecode-core.js', import.meta.url),
    'utf8',
  )
  assert.equal(source.includes("from 'node:"), false)
  assert.equal(source.includes("from '../host/"), false)
  assert.equal(source.includes('from "../host/'), false)
})

async function loadGraph(entry) {
  const source = await readFile(new URL(`../${entry.graph}`, import.meta.url), 'utf8')
  const checked = checkSource(source, { file: entry.graph })
  assert.equal(checked.ok, true)
  return {
    ...checked.program,
    graph_revision: entry.graph_revision,
  }
}

function scriptedCapability(entry) {
  let index = 0
  return (instance, member, args, invocationId) => {
    const expected = entry.invocations[index]
    index += 1
    assert.notEqual(expected, undefined, entry.id)
    assert.deepEqual({
      arguments: args,
      instance,
      invocation_id: invocationId,
      member,
    }, {
      arguments: decodeValue(expected.arguments),
      instance: expected.instance,
      invocation_id: expected.invocation_id,
      member: expected.member,
    }, entry.id)
    return decodeValue(expected.response)
  }
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue)
  if (value !== null && typeof value === 'object') {
    if (Object.keys(value).length === 1
      && typeof value.$bytes === 'string') {
      return decodeBytes(value.$bytes)
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodeValue(child)]),
    )
  }
  return value
}

function decodeBytes(value) {
  const bytes = new Uint8Array((value.length - 4) / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      value.slice(4 + index * 2, 6 + index * 2),
      16,
    )
  }
  return bytes
}

function digest(character) {
  return `sha256:${character.repeat(64)}`
}
