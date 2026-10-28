import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { checkSource } from '../src/toolchain/demo-toolchain.js'
import {
  compilePortableBytecode,
} from '../src/toolchain/portable-bytecode.js'
import {
  PORTABLE_BYTECODE_PROCESS_REQUEST_SCHEMA,
  createPortableBytecodeProcessRequest,
  executePortableBytecodeProcess,
  executePortableBytecodeProcessRequest,
  parsePortableBytecodeProcessRequestLine,
  portableBytecodeProcessRequestDigest,
} from '../src/toolchain/portable-bytecode-process.js'

const repository = new URL('../', import.meta.url)
const bundle = JSON.parse(await readFile(
  new URL('./fixtures/portable-conformance.json', import.meta.url),
  'utf8',
))

test('portable bytecode process protocol preserves all nine oracle cases', async () => {
  for (const entry of bundle.cases) {
    const graph = await loadGraph(entry)
    const artifact = compilePortableBytecode(graph)
    assert.equal(artifact.ok, true, entry.id)
    const request = createPortableBytecodeProcessRequest({
      artifact: artifact.value,
      checkedGraph: graph,
      invocations: entry.invocations,
    })
    assert.equal(request.ok, true, entry.id)
    assert.equal(request.value.schema, PORTABLE_BYTECODE_PROCESS_REQUEST_SCHEMA)

    const result = await executePortableBytecodeProcess({
      request: request.value,
      timeoutMs: 2_000,
    })
    assert.equal(result.ok, true, entry.id)
    assert.equal(
      result.value.request_digest,
      request.value.request_digest,
      entry.id,
    )
    assert.deepEqual(
      result.value.execution.outcome,
      entry.expected.outcome,
      entry.id,
    )
    assert.deepEqual(
      result.value.execution.invocations,
      entry.expected.receipt.invocations,
      entry.id,
    )
  }
})

test('portable bytecode process request rejects field, digest, script and result drift', async () => {
  const entry = bundle.cases[0]
  const graph = await loadGraph(entry)
  const artifact = compilePortableBytecode(graph)
  assert.equal(artifact.ok, true)
  const created = createPortableBytecodeProcessRequest({
    artifact: artifact.value,
    checkedGraph: graph,
    invocations: entry.invocations,
  })
  assert.equal(created.ok, true)

  for (const [label, mutate, code, refresh = false] of [
    [
      'extra field',
      (request) => { request.extra = true },
      'portable-bytecode-process-request-unexpected-field',
    ],
    [
      'graph digest',
      (request) => { request.graph_revision = digest('e') },
      'portable-bytecode-process-graph-revision-mismatch',
      true,
    ],
    [
      'artifact digest',
      (request) => { request.artifact_digest = digest('d') },
      'portable-bytecode-process-artifact-digest-mismatch',
      true,
    ],
    [
      'invocation identity',
      (request) => { request.invocations[0].member = 'read' },
      'portable-bytecode-process-invocation-mismatch',
      true,
    ],
    [
      'invocation arguments',
      (request) => { request.invocations[0].arguments.data = 'changed' },
      'portable-bytecode-process-invocation-arguments-mismatch',
      true,
    ],
    [
      'invocation response',
      (request) => { request.invocations[0].response.value.kind = 'err' },
      'portable-bytecode-process-request-digest-mismatch',
    ],
    [
      'missing invocation',
      (request) => { request.invocations = [] },
      'portable-bytecode-process-invocation-mismatch',
      true,
    ],
    [
      'duplicate invocation',
      (request) => {
        request.invocations.push(structuredClone(request.invocations[0]))
      },
      'portable-bytecode-process-invocation-mismatch',
      true,
    ],
  ]) {
    const changed = structuredClone(created.value)
    mutate(changed)
    if (refresh) {
      changed.request_digest = portableBytecodeProcessRequestDigest(changed)
    }
    const result = executePortableBytecodeProcessRequest(changed)
    assert.equal(result.ok, false, label)
    assert.ok(result.diagnostics.some(
      (diagnostic) => diagnostic.code === code,
    ), label)
  }

})

test('portable bytecode process line protocol is bounded and exact', async () => {
  assert.deepEqual(parsePortableBytecodeProcessRequestLine('{'), {
    diagnostics: [{ code: 'portable-bytecode-process-request-json-invalid' }],
    ok: false,
  })
  assert.deepEqual(parsePortableBytecodeProcessRequestLine('{}\n{}\n'), {
    diagnostics: [{ code: 'portable-bytecode-process-request-line-invalid' }],
    ok: false,
  })
  assert.deepEqual(
    parsePortableBytecodeProcessRequestLine(
      `${' '.repeat(1_048_576)}\n`,
    ),
    {
      diagnostics: [{ code: 'portable-bytecode-process-request-too-large' }],
      ok: false,
    },
  )
})

test('portable bytecode process terminates timed out and early-exit workers', async (t) => {
  const entry = bundle.cases[0]
  const graph = await loadGraph(entry)
  const artifact = compilePortableBytecode(graph)
  const request = createPortableBytecodeProcessRequest({
    artifact: artifact.value,
    checkedGraph: graph,
    invocations: entry.invocations,
  })
  assert.equal(request.ok, true)

  const root = await mkdtemp(join(tmpdir(), 're-bytecode-process-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const earlyExit = join(root, 'early-exit.js')
  const forgedResult = join(root, 'forged-result.js')
  const malformedResult = join(root, 'malformed-result.js')
  const oversizedResult = join(root, 'oversized-result.js')
  const timeout = join(root, 'timeout.js')
  await writeFile(earlyExit, 'process.exit(0)\n')
  await writeFile(forgedResult, `
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { input += chunk })
    process.stdin.on('end', () => {
      const request = JSON.parse(input)
      process.stdout.write(JSON.stringify({
        ok: true,
        value: {
          execution: {
            artifact_digest: request.artifact_digest,
            graph_revision: request.graph_revision,
            invocations: [],
            outcome: { code: 255, type: 'process.status' },
            profile: request.artifact.profile,
            schema: 're.portable-bytecode-result@0.1.0'
          },
          request_digest: request.request_digest,
          schema: 're.portable-bytecode-process-result@0.1.0'
        }
      }) + '\\n')
    })
  `)
  await writeFile(malformedResult, `
    process.stdin.resume()
    process.stdin.on('end', () => process.stdout.write('{\\n'))
  `)
  await writeFile(oversizedResult, `
    process.stdin.resume()
    process.stdin.on('end', () => process.stdout.write('x'.repeat(1_048_577)))
  `)
  await writeFile(timeout, 'setInterval(() => {}, 1000)\n')

  assert.deepEqual(await executePortableBytecodeProcess({
    request: request.value,
    timeoutMs: 500,
    workerPath: earlyExit,
  }), {
    diagnostics: [{ code: 'portable-bytecode-process-child-exit' }],
    ok: false,
  })
  assert.deepEqual(await executePortableBytecodeProcess({
    request: request.value,
    timeoutMs: 25,
    workerPath: timeout,
  }), {
    diagnostics: [{ code: 'portable-bytecode-process-timeout' }],
    ok: false,
  })
  assert.deepEqual(await executePortableBytecodeProcess({
    request: request.value,
    timeoutMs: 500,
    workerPath: forgedResult,
  }), {
    diagnostics: [{ code: 'portable-bytecode-process-result-mismatch' }],
    ok: false,
  })
  assert.deepEqual(await executePortableBytecodeProcess({
    request: request.value,
    timeoutMs: 500,
    workerPath: malformedResult,
  }), {
    diagnostics: [{ code: 'portable-bytecode-process-result-json-invalid' }],
    ok: false,
  })
  assert.deepEqual(await executePortableBytecodeProcess({
    request: request.value,
    timeoutMs: 500,
    workerPath: oversizedResult,
  }), {
    diagnostics: [{ code: 'portable-bytecode-process-result-too-large' }],
    ok: false,
  })
})

async function loadGraph(entry) {
  const source = await readFile(new URL(entry.graph, repository), 'utf8')
  const checked = checkSource(source, { file: entry.graph })
  assert.equal(checked.ok, true, entry.id)
  return { ...checked.program, graph_revision: entry.graph_revision }
}

function digest(character) {
  return `sha256:${character.repeat(64)}`
}
