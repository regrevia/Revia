import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  buildPrompt,
  parseModelResponse,
  runOllamaColdStart,
  validateAgentAction,
} from '../src/toolchain/cold-start-runner.js'
import {
  assertReleaseLock,
  releaseLockDigest,
} from '../src/toolchain/release-lock.js'

const pack = JSON.parse(await readFile(
  new URL('./fixtures/cold-start-tasks.json', import.meta.url),
  'utf8',
))
const releaseLock = JSON.parse(await readFile(
  new URL('./fixtures/g6-release-lock.json', import.meta.url),
  'utf8',
))
const repairGolden = JSON.parse(await readFile(
  new URL('./golden/g6-repair-diagnostic.json', import.meta.url),
  'utf8',
))

test('G6 release lock binds the task pack, slots, tools, and deterministic runner', () => {
  assert.doesNotThrow(() => assertReleaseLock(
    releaseLock,
    pack,
    'sha256:f3b4c9d9fbde7773a0aa842516b3a71ca41fc2dd80576fcbbe0639d2561db3b8',
  ))
  assert.match(releaseLockDigest(releaseLock), /^sha256:[0-9a-f]{64}$/)
  assert.equal(releaseLock.runner.temperature, 0)
  assert.equal(releaseLock.runner.stream, false)
})

test('Ollama prompt excludes the secret canary and forbids unverified tools', () => {
  const prompt = buildPrompt(pack, pack.tasks[0])
  assert.equal(prompt.includes(pack.secret_canary), false)
  assert.match(prompt, /explicitly allowed tools/)
  assert.match(prompt, /action":"tool/)
  assert.match(prompt, /re\.g6-agent-protocol@0\.1\.0/)
  assert.match(prompt, /"allowed_tools":\["source\.read","re\.check"\]/)
  assert.match(prompt, /"required":\["source","check_result","graph_summary"\]/)
})

test('task prompt hides tool schemas that the current task cannot request', () => {
  const repair = pack.tasks.find(({ id }) => id === 'G6-002')
  const prompt = buildPrompt(pack, repair)

  assert.match(prompt, /Only task-contract allowed_tools may be requested/)
  assert.match(prompt, /"re\.check"/)
  assert.match(prompt, /re\.check\.stdout/)
  assert.equal(prompt.includes('"re.patch"'), false)
  assert.equal(prompt.includes('"re.module.resolve"'), false)
  assert.equal(prompt.includes('"re.run"'), false)
  assert.equal(prompt.includes('"golden"'), false)
  assert.ok(prompt.length < 1800, `prompt length ${prompt.length} exceeds task budget`)
})

test('agent action schema rejects extra fields, wrong shapes, and task-disallowed tools', () => {
  const task = pack.tasks.find(({ id }) => id === 'G6-001')

  assert.equal(validateAgentAction(pack, task, {
    action: 'tool',
    input: { path: 'examples/hello.re' },
    tool: 're.check',
  }), null)
  assert.equal(validateAgentAction(pack, task, {
    action: 'tool',
    input: { path: 'examples/hello.re' },
    note: 'unfrozen',
    tool: 're.check',
  }), 'invalid-model-action-schema')
  assert.equal(validateAgentAction(pack, task, {
    action: 'tool',
    input: {},
    tool: 're.patch',
  }), 'disallowed-task-tool')
  assert.equal(validateAgentAction(pack, task, {
    action: 'final',
    output: {
      check_result: {},
      source: 're 1.0 compact\n',
    },
  }), 'invalid-final-output-schema')
  assert.equal(validateAgentAction(pack, task, {
    action: 'final',
    output: {
      check_result: {},
      graph_summary: {},
      migration: {},
      source: 're 1.0 compact\n',
    },
  }), null)
})

test('task-fixed tool input rejects a model-invented stale patch', () => {
  const task = pack.tasks.find(({ id }) => id === 'G6-004')
  const fixed = task.agent_contract.fixed_tool_inputs['re.patch']

  assert.equal(validateAgentAction(pack, task, {
    action: 'tool',
    input: fixed,
    tool: 're.patch',
  }), null)
  assert.equal(validateAgentAction(pack, task, {
    action: 'tool',
    input: {
      patch: {
        ...fixed.patch,
        baseRevision: `sha256:${'1'.repeat(64)}`,
      },
    },
    tool: 're.patch',
  }), 'invalid-task-tool-input')
})

test('model response parser accepts JSON fences and fails closed', () => {
  assert.deepEqual(parseModelResponse('```json\n{"oracle_passed":true}\n```'), {
    oracle_passed: true,
  })
  assert.deepEqual(parseModelResponse('not json'), {})
  assert.deepEqual(parseModelResponse('[]'), {})
})

test('malformed model tool traces become controlled failed probes', async () => {
  const reports = await runOllamaColdStart({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          response: JSON.stringify({
            output: { source: 'probe' },
            tool_trace: [{ tool: 'shell.exec' }],
          }),
        }
      },
    }),
    modelBindings: {
      'model-a': 'a',
      'model-b': 'b',
      'model-c': 'c',
    },
    taskIds: ['G6-001'],
  })

  assert.ok(reports.every(({ semantic_accuracy }) => semantic_accuracy.success === false))
})

test('Ollama runner maps real responses into anonymous blind reports', async () => {
  const calls = []
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body))
    return {
      ok: true,
      async json() {
        return {
          eval_count: 3,
          prompt_eval_count: 7,
          response: JSON.stringify({
            oracle_passed: true,
            output: { source: 'probe' },
            tool_trace: [],
          }),
        }
      },
    }
  }
  const reports = await runOllamaColdStart({
    fetchImpl,
    modelBindings: {
      'model-a': 'qwen2.5-coder:7b',
      'model-b': 'gemma4:12b',
      'model-c': 'llama3.1:8b',
    },
    taskIds: ['G6-001'],
  })

  assert.equal(reports.length, 3)
  assert.deepEqual(reports.map(({ model }) => model), [
    'model-a',
    'model-b',
    'model-c',
  ])
  assert.ok(reports.every(({ hard_fail }) => hard_fail === false))
  assert.ok(reports.every(({ semantic_accuracy }) => semantic_accuracy.success === false))
  assert.ok(reports.every(({ repair_cost }) => repair_cost.output_tokens === 10))
  assert.deepEqual(calls.map(({ model }) => model), [
    'qwen2.5-coder:7b',
    'gemma4:12b',
    'llama3.1:8b',
  ])
})

test('tool mode executes only allowed actions and derives oracle from the trace', async () => {
  let call = 0
  const fetchImpl = async (_url, options) => {
    call += 1
    const action = call % 2 === 1
      ? {
        action: 'tool',
        input: { path: 'examples/hello.re' },
        tool: 're.check',
      }
      : {
        action: 'final',
        output: {
          check_result: {
            diagnostics: [],
            file: 'examples/hello.re',
            ok: true,
            schema: 're.check-result@0.1.0',
          },
          graph_summary: {},
          source: 're 0.1 compact\nunit hello\n',
        },
      }
    return {
      ok: true,
      async json() {
        return { eval_count: 1, prompt_eval_count: 1, response: JSON.stringify(action) }
      },
    }
  }
  const reports = await runOllamaColdStart({
    fetchImpl,
    modelBindings: {
      'model-a': 'a',
      'model-b': 'b',
      'model-c': 'c',
    },
    taskIds: ['G6-001'],
    toolsEnabled: true,
  })

  assert.equal(reports.length, 3)
  assert.ok(reports.every(({ semantic_accuracy }) => semantic_accuracy.success === true))
  assert.equal(call, 6)
})

test('tool mode rejects a forged success after a real failed check', async () => {
  let call = 0
  const fetchImpl = async () => {
    call += 1
    const action = call % 2 === 1
      ? {
        action: 'tool',
        input: { path: 'test/fixtures/wrong-argument.re' },
        tool: 're.check',
      }
      : {
        action: 'final',
        output: {
          check_result: { diagnostics: [], file: 'test/fixtures/wrong-argument.re', ok: true },
          graph_summary: {},
          source: 'forged',
        },
      }
    return {
      ok: true,
      async json() {
        return { eval_count: 1, prompt_eval_count: 1, response: JSON.stringify(action) }
      },
    }
  }
  const reports = await runOllamaColdStart({
    fetchImpl,
    modelBindings: {
      'model-a': 'a',
      'model-b': 'b',
      'model-c': 'c',
    },
    taskIds: ['G6-001'],
    toolsEnabled: true,
  })

  assert.ok(reports.every(({ semantic_accuracy }) => semantic_accuracy.success === false))
  assert.ok(reports.every(({ hard_gates }) => hard_gates['check-before-run'] === true))
})

test('repair task accepts its frozen nonzero check status and exact diagnostic output', async () => {
  let call = 0
  const fetchImpl = async () => {
    call += 1
    const action = call % 2 === 1
      ? {
        action: 'tool',
        input: { path: 'test/fixtures/wrong-argument.re' },
        tool: 're.check',
      }
      : {
        action: 'final',
        output: {
          check_result: repairGolden,
          diagnostic: repairGolden.diagnostics[0],
          patch: { operations: [] },
        },
      }
    return {
      ok: true,
      async json() {
        return { eval_count: 1, prompt_eval_count: 1, response: JSON.stringify(action) }
      },
    }
  }
  const reports = await runOllamaColdStart({
    fetchImpl,
    modelBindings: {
      'model-a': 'a',
      'model-b': 'b',
      'model-c': 'c',
    },
    taskIds: ['G6-002'],
    toolsEnabled: true,
  })

  assert.equal(call, 6)
  assert.ok(reports.every(({ runner_error: error }) => error === undefined))
  assert.ok(reports.every(({ semantic_accuracy }) => semantic_accuracy.success === true))
})

test('cross-module task can finish by returning the exact resolver result', async () => {
  const task = pack.tasks.find(({ id }) => id === 'G6-003')
  const reports = await runOllamaColdStart({
    fetchImpl: toolResultFetch('re.module.resolve', {
      finalOutput: (result) => result,
    }),
    modelBindings: {
      'model-a': 'a',
      'model-b': 'b',
      'model-c': 'c',
    },
    taskIds: [task.id],
    toolsEnabled: true,
  })

  assert.ok(reports.every(({ semantic_accuracy }) => semantic_accuracy.success === true))
})

test('stale patch task exposes one valid fixed action and preserves conflict anchors', async () => {
  const task = pack.tasks.find(({ id }) => id === 'G6-004')
  const reports = await runOllamaColdStart({
    fetchImpl: toolResultFetch('re.patch', {
      finalOutput: (result) => ({
        conflict_diagnostic: result.result.diagnostics[0],
        unchanged_revision: result.unchanged_revision,
      }),
    }),
    modelBindings: {
      'model-a': 'a',
      'model-b': 'b',
      'model-c': 'c',
    },
    taskIds: [task.id],
    toolsEnabled: true,
  })

  assert.ok(reports.every(({ semantic_accuracy }) => semantic_accuracy.success === true))
  assert.ok(reports.every(({ hard_fail: hardFail }) => hardFail === false))
})

test('tool mode fails closed at the locked round budget', async () => {
  let call = 0
  const fetchImpl = async () => {
    call += 1
    return {
      ok: true,
      async json() {
        return {
          eval_count: 1,
          prompt_eval_count: 1,
          response: JSON.stringify({
            action: 'tool',
            input: { path: 'examples/hello.re' },
            tool: 'source.read',
          }),
        }
      },
    }
  }
  const reports = await runOllamaColdStart({
    fetchImpl,
    modelBindings: {
      'model-a': 'a',
      'model-b': 'b',
      'model-c': 'c',
    },
    releaseLock: {
      ...releaseLock,
      budget: { ...releaseLock.budget, max_tool_rounds: 1 },
    },
    taskIds: ['G6-001'],
    toolsEnabled: true,
  })

  assert.equal(call, 3)
  assert.ok(reports.every(({ semantic_accuracy }) => semantic_accuracy.success === false))
  assert.ok(reports.every(({ release_lock_digest }) =>
    /^sha256:[0-9a-f]{64}$/.test(release_lock_digest),
  ))
})

test('tool mode fails closed when cumulative tokens exceed the release lock', async () => {
  let call = 0
  const fetchImpl = async () => {
    call += 1
    return {
      ok: true,
      async json() {
        return {
          eval_count: 1,
          prompt_eval_count: 1,
          response: JSON.stringify({
            action: 'tool',
            input: { path: 'examples/hello.re' },
            tool: 'source.read',
          }),
        }
      },
    }
  }
  const reports = await runOllamaColdStart({
    fetchImpl,
    modelBindings: {
      'model-a': 'a',
      'model-b': 'b',
      'model-c': 'c',
    },
    releaseLock: {
      ...releaseLock,
      budget: {
        ...releaseLock.budget,
        max_total_tokens: 3,
        max_output_tokens_per_call: 2,
        max_tool_rounds: 12,
      },
    },
    taskIds: ['G6-001'],
    toolsEnabled: true,
  })

  assert.equal(call, 6)
  assert.ok(reports.every(({ runner_error }) => runner_error === 'token-budget-exceeded'))
  assert.ok(reports.every(({ semantic_accuracy }) => semantic_accuracy.success === false))
})

function toolResultFetch(tool, { finalOutput }) {
  return async (_url, options) => {
    const { prompt } = JSON.parse(options.body)
    const marker = `Tool ${tool} result:\n`
    const markerIndex = prompt.lastIndexOf(marker)
    const action = markerIndex === -1
      ? {
        action: 'tool',
        input: pack.tasks.find(({ agent_contract: contract }) =>
          contract.required_tools.includes(tool),
        ).agent_contract.fixed_tool_inputs[tool],
        tool,
      }
      : {
        action: 'final',
        output: finalOutput(JSON.parse(prompt.slice(markerIndex + marker.length))),
      }
    return {
      ok: true,
      async json() {
        return { eval_count: 1, prompt_eval_count: 1, response: JSON.stringify(action) }
      },
    }
  }
}
