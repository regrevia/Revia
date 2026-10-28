import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pack = JSON.parse(await readFile(
  new URL('./fixtures/cold-start-tasks.json', import.meta.url),
  'utf8',
))

test('G6 cold-start pack binds four tasks without claiming model results', () => {
  assert.equal(pack.schema, 're.g6-cold-start@0.5.0')
  assert.equal(pack.status, 'fixture-bound')
  assert.equal(pack.agent_protocol.schema, 're.g6-agent-protocol@0.1.0')
  assert.deepEqual(pack.models, ['model-a', 'model-b', 'model-c'])
  assert.equal(new Set(pack.tasks.map(({ id }) => id)).size, pack.tasks.length)
  assert.deepEqual(
    pack.tasks.map(({ operation }) => operation),
    ['create', 'repair', 'cross-module', 'uid-patch'],
  )
  for (const task of pack.tasks) {
    assert.match(task.input_fixture.sha256, /^[0-9a-f]{64}$/)
    assert.ok(task.oracle.kind)
    assert.ok(task.required_output.length > 0)
    assert.equal(typeof task.agent_contract.instruction, 'string')
    assert.ok(task.agent_contract.instruction.length > 0)
    assert.ok(task.agent_contract.allowed_tools.length > 0)
    assert.deepEqual(
      task.agent_contract.final_output.required,
      task.required_output,
    )
    assert.ok(task.required_output.every((field) =>
      Object.hasOwn(task.agent_contract.field_sources, field),
    ))
  }
})

test('G6 task contracts are closed and use only catalogued tools', () => {
  const toolCatalog = new Set(pack.allowed_tools)

  for (const task of pack.tasks) {
    assert.equal(task.agent_contract.final_output.additional_properties, false)
    assert.ok(task.agent_contract.allowed_tools.every((tool) => toolCatalog.has(tool)))
    assert.ok(task.agent_contract.required_tools.every((tool) =>
      task.agent_contract.allowed_tools.includes(tool),
    ))
    assert.ok(task.agent_contract.required_tools.every((tool) =>
      Object.hasOwn(task.agent_contract.fixed_tool_inputs, tool),
    ))
    assert.ok(task.required_output.every((field) =>
      Object.hasOwn(task.agent_contract.final_output.properties, field),
    ))
  }
})

test('G6 applies only meaningful hard gates to each task', () => {
  const catalog = new Set(pack.security_hard_gates)

  for (const task of pack.tasks) {
    assert.ok(task.applicable_hard_gates.length > 0)
    assert.ok(task.applicable_hard_gates.every((gate) => catalog.has(gate)))
  }
  assert.deepEqual(
    pack.tasks.find(({ id }) => id === 'G6-004').applicable_hard_gates,
    [
      'no-unsafe-host-call',
      'no-secret-in-source-or-output',
      'revision-conflict-preserves-anchors',
    ],
  )
  assert.deepEqual(
    pack.tasks.find(({ id }) => id === 'G6-003').applicable_hard_gates,
    [
      'no-unsafe-host-call',
      'no-secret-in-source-or-output',
      'exact-revision-dependency',
    ],
  )
  assert.equal(
    pack.scoring.hard_gate,
    'all_applicable_security_hard_gates_pass',
  )
})
