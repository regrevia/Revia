import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { demoSchemaDefinitions } from '../src/host/demo-schema.js'
import {
  checkProcessExitLiteral,
  processExit,
  runProgram,
  runProgramAsJson,
} from '../src/host/demo-runner.js'
import { HostEnvironment } from '../src/host/host-environment.js'
import { MemoryAdapter } from '../src/host/memory-adapter.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'

class FailingStdoutAdapter {
  supportedInterfaces() {
    return ['process.stdout@0.1.0']
  }

  invoke() {
    throw new Error('transport detail')
  }
}

test('EXIT-001 maps process.exit(0) after main returns', () => {
  const result = runProgram({
    check: () => ({ ok: true }),
    execute: () => processExit(0),
  })

  assert.deepEqual(result, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: '',
  })
})

test('EXIT-002 accepts the maximum process.exit_code', () => {
  const result = runProgram({
    check: () => ({ ok: true }),
    execute: () => processExit('255'),
  })

  assert.deepEqual(result.outcome, {
    kind: 'process-status',
    status: { code: 255 },
  })
})

test('EXIT-003 rejects process.exit(256) before execution', () => {
  let executed = false
  const result = runProgram({
    check: () =>
      checkProcessExitLiteral(256, {
        column: 23,
        file: 'main.re',
        line: 1,
      }),
    execute: () => {
      executed = true
      return processExit(256)
    },
  })

  assert.equal(executed, false)
  assert.deepEqual(result, {
    outcome: {
      diagnostics: [
        {
          actual: 256,
          code: 'process-exit-code-out-of-range',
          column: 23,
          expected: '0..255',
          file: 'main.re',
          line: 1,
          type: 'process.exit_code',
        },
      ],
      kind: 'check-failure',
    },
    programStdout: '',
  })
})

test('EXIT-004 maps status only after stdout result is consumed', () => {
  const stdout = []
  const adapter = new MemoryAdapter({ stdout })
  const registry = SchemaRegistry.load(demoSchemaDefinitions()).value
  const host = HostEnvironment.bind({
    bindings: [{ adapter, instance: '@stdout' }],
    capabilities: [
      { instance: '@stdout', reference: 'process.stdout@0.1.0' },
    ],
    registry,
  }).value

  const result = runProgram({
    check: () => ({ ok: true }),
    execute: () => {
      const written = host.invoke(
        '@stdout',
        'write',
        { data: 'ready\n' },
        'exit-4-write',
      )
      return processExit(written.value.kind === 'ok' ? 0 : 1)
    },
    readProgramStdout: () => stdout.join(''),
  })

  assert.deepEqual(result, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: 'ready\n',
  })
})

test('EXIT-005 preserves a host fault produced before status', () => {
  const registry = SchemaRegistry.load(demoSchemaDefinitions()).value
  const host = HostEnvironment.bind({
    bindings: [
      { adapter: new FailingStdoutAdapter(), instance: '@stdout' },
    ],
    capabilities: [
      { instance: '@stdout', reference: 'process.stdout@0.1.0' },
    ],
    registry,
  }).value

  const result = runProgram({
    check: () => ({ ok: true }),
    execute: () => {
      const written = host.invoke(
        '@stdout',
        'write',
        { data: 'never written' },
        'exit-5-write',
      )
      return written.kind === 'host-fault' ? written : processExit(0)
    },
  })

  assert.deepEqual(result, {
    outcome: {
      fault: {
        capability_instance: '@stdout',
        capability_reference: 'process.stdout@0.1.0',
        code: 'host-contract-violation',
        invocation_id: 'exit-5-write',
        member: 'write',
        phase: 'invoke',
        reason: 'adapter-panicked',
      },
      kind: 'host-fault',
    },
    programStdout: '',
  })
})

test('runner JSON driver matches the byte-exact process-status golden', async () => {
  const actual = runProgramAsJson({
    check: () => ({ ok: true }),
    execute: () => processExit(1),
    readProgramStdout: () => 'ready\n',
  })
  const expected = await readFile(
    new URL('golden/run-process-status.json', import.meta.url),
    'utf8',
  )

  assert.equal(actual, expected)
})
