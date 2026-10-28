import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { AgentBusinessHttpAdapter } from '../src/host/agent-business-http-adapter.js'
import { AgentBusinessSqliteAdapter } from '../src/host/agent-business-sqlite-adapter.js'
import {
  createServerDbSqliteFileHandle,
} from '../src/host/server-db-sqlite-file.js'
import { loadProjectDirectory } from '../src/toolchain/project-loader.js'
import {
  executeProjectRun,
  verifyProjectRunReceipt,
} from '../src/toolchain/project-runner.js'

const root = new URL('../examples/agent-expense-review/', import.meta.url)
const fixturePath = new URL('../examples/agent-expense-review-run.json', import.meta.url).pathname
let projectPath

test.before(async () => {
  projectPath = await mkdtemp(`${tmpdir()}/re-agent-expense-review-`)
  await cp(root.pathname, projectPath, { recursive: true })
})

test.after(async () => {
  await rm(projectPath, { force: true, recursive: true })
})

test('materialized project-run executes a checked task and emits deterministic replay receipt', () => {
  const first = run(['project-run', '--fixture', fixturePath, projectPath])
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.value.ok, true)
  assert.equal(first.value.receipt.schema, 're.project-run-receipt@0.3.0')
  assert.equal(
    first.value.receipt.business.function,
    'agent.expense.intake.review',
  )
  assert.match(
    first.value.receipt.business.declaration_digest,
    /^sha256:[0-9a-f]{64}$/,
  )
  assert.deepEqual(
    first.value.receipt.business.execution_trace.map(
      ({ call, request_id }) => ({ call, request_id }),
    ),
    [
      { call: 'expense_db_read', request_id: 'expense-001:1' },
      { call: 'expense_db_read', request_id: 'expense-001:2' },
    ],
  )
  assert.match(first.value.receipt.receipt_digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(first.value.receipt.graph_revision, 'sha256:d4099ef70fe7123c1e40a490f30643925b1f32746b1873ac12d184f603c5e856')
  assert.equal(first.value.receipt.task.name, 'agent.expense.intake.task')
  assert.equal(first.value.receipt.task.outcome, 'succeeded')
  assert.equal(first.value.receipt.task.attempts, 2)
  assert.equal(first.value.receipt.replay.replayed, true)
  assert.equal(first.value.receipt.concurrency.verification.ok, true)
  assert.deepEqual(first.value.receipt.typed_outcome, {
    kind: 'ok',
    value: { approved: true, currency: { variant: 'usd' } },
  })

  const second = run(['project-run', '--fixture', fixturePath, projectPath])
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(second.value, first.value)
})

test('project-run receipt verifier rejects identity and payload drift', async () => {
  const loaded = await loadProjectDirectory(projectPath)
  assert.equal(loaded.ok, true)
  const executed = await executeProjectRun(loaded.value, fixturePath)
  assert.equal(executed.ok, true)
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
  assert.deepEqual(
    verifyProjectRunReceipt(loaded.value, fixture, executed.value),
    { ok: true },
  )

  for (const mutate of [
    (receipt) => ({ ...receipt, graph_revision: `sha256:${'0'.repeat(64)}` }),
    (receipt) => ({ ...receipt, typed_outcome: { kind: 'cancelled' } }),
    (receipt) => ({ ...receipt, receipt_digest: `sha256:${'f'.repeat(64)}` }),
  ]) {
    const verification = verifyProjectRunReceipt(
      loaded.value,
      fixture,
      mutate(structuredClone(executed.value)),
    )
    assert.equal(verification.ok, false)
    assert.equal(verification.diagnostics[0].code, 'invalid-project-run-receipt')
  }

  const replacedOutput = structuredClone(executed.value)
  replacedOutput.typed_outcome.value.approved = false
  replacedOutput.receipt_digest = receiptDigest(replacedOutput)
  assert.equal(
    verifyProjectRunReceipt(loaded.value, fixture, replacedOutput).ok,
    false,
  )

  const replacedTrace = structuredClone(executed.value)
  replacedTrace.business.execution_trace[0].outcome_digest =
    `sha256:${'0'.repeat(64)}`
  replacedTrace.receipt_digest = receiptDigest(replacedTrace)
  assert.equal(
    verifyProjectRunReceipt(loaded.value, fixture, replacedTrace).ok,
    false,
  )

  const replacedInputDigest = structuredClone(executed.value)
  replacedInputDigest.business.execution_trace[0].input_digest =
    `sha256:${'0'.repeat(64)}`
  replacedInputDigest.receipt_digest = receiptDigest(replacedInputDigest)
  assert.equal(
    verifyProjectRunReceipt(loaded.value, fixture, replacedInputDigest).ok,
    false,
  )

  const truncatedTrace = structuredClone(executed.value)
  truncatedTrace.business.execution_trace.pop()
  truncatedTrace.receipt_digest = receiptDigest(truncatedTrace)
  assert.equal(
    verifyProjectRunReceipt(loaded.value, fixture, truncatedTrace).ok,
    false,
  )
})

test('project-run rejects graph drift, unknown cases, and translation artifacts before adapter use', async () => {
  const temporary = await temporaryFixture('selection.json')
  const original = await readFile(fixturePath, 'utf8')
  const cases = [
    ['graph drift', (value) => ({ ...value, graph_revision: `sha256:${'0'.repeat(64)}` }), 'project-run-graph-revision-mismatch'],
    ['unknown case', (value) => ({ ...value, case: 'agent.expense.intake.unknown' }), 'project-run-case-not-found'],
    ['translation artifact', (value) => ({ ...value, translation: { locale: 'en-US', media: 'json' } }), 'unexpected-project-run-selection-field'],
  ]
  try {
    for (const [label, mutate, code] of cases) {
      await writeFile(temporary.path, JSON.stringify(mutate(JSON.parse(original))))
      const result = run(['project-run', '--fixture', temporary.path, projectPath])
      assert.equal(result.status, 65, label)
      assert.equal(result.value.ok, false, label)
      assert.equal(result.value.diagnostics[0].code, code, label)
    }
  } finally {
    await temporary.cleanup()
  }
})

test('project-run closes retry exhaustion and cancellation as typed outcomes without replayed effects', async () => {
  const temporary = await temporaryFixture('outcomes.json')
  const original = JSON.parse(await readFile(fixturePath, 'utf8'))
  try {
    const exhausted = structuredClone(original)
    exhausted.case = 'agent.expense.intake.exhausted'
    await writeFile(temporary.path, JSON.stringify(exhausted))
    const failed = run(['project-run', '--fixture', temporary.path, projectPath])
    assert.equal(failed.status, 0)
    assert.equal(failed.value.receipt.task.outcome, 'failed')
    assert.equal(failed.value.receipt.task.attempts, 2)
    assert.equal(failed.value.receipt.task.effect_key, null)
    assert.equal(failed.value.receipt.replay, null)
    assert.deepEqual(failed.value.receipt.typed_outcome, {
      error: { code: 'transient', message: 'transient' },
      kind: 'err',
    })

    const cancelledFixture = structuredClone(original)
    cancelledFixture.run.cancel_at = 'before_start'
    await writeFile(temporary.path, JSON.stringify(cancelledFixture))
    const cancelled = run(['project-run', '--fixture', temporary.path, projectPath])
    assert.equal(cancelled.status, 0)
    assert.equal(cancelled.value.receipt.task.outcome, 'cancelled')
    assert.equal(cancelled.value.receipt.task.attempts, 0)
    assert.equal(cancelled.value.receipt.task.effect_key, null)
    assert.equal(cancelled.value.receipt.replay, null)
    assert.deepEqual(cancelled.value.receipt.typed_outcome, { kind: 'cancelled' })

    const withoutReplay = structuredClone(original)
    withoutReplay.run.replay = false
    await writeFile(temporary.path, JSON.stringify(withoutReplay))
    const noReplay = run(['project-run', '--fixture', temporary.path, projectPath])
    assert.equal(noReplay.status, 0)
    assert.equal(noReplay.value.receipt.task.outcome, 'succeeded')
    assert.equal(noReplay.value.receipt.replay, null)
  } finally {
    await temporary.cleanup()
  }
})

test('project-run rejects source contract drift, legacy sidecars, and symlinked fixtures before execution', async () => {
  const sourcePath = join(projectPath, 'modules/intake.re')
  const manifestPath = join(projectPath, 'project.json')
  const originalSource = await readFile(sourcePath, 'utf8')
  const originalManifest = await readFile(manifestPath, 'utf8')
  const evidencePath = join(projectPath, 'review-evidence.json')
  const symlinkFixture = await temporaryFixture('symlink.json')
  try {
    const mutated = originalSource
      .replace('"backoff_ms":[0]', '"backoff_ms":[0,0]')
      .replace('"max_attempts":2', '"max_attempts":3')
    assert.notEqual(mutated, originalSource)
    const sourceSha256 = sourceDigest(mutated)
    const manifest = JSON.parse(originalManifest)
    manifest.modules.find(({ name }) => name === 'agent.expense.intake').source_sha256 =
      sourceSha256
    manifest.package_manifest.modules.find(
      ({ name }) => name === 'agent.expense.intake',
    ).implementation_digest = sourceSha256
    await writeFile(sourcePath, mutated)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const drifted = run(['project-run', '--fixture', fixturePath, projectPath])
    assert.equal(drifted.status, 65)
    assert.equal(
      drifted.value.diagnostics[0].code,
      'project-run-graph-revision-mismatch',
    )
    await writeFile(sourcePath, originalSource)
    await writeFile(manifestPath, originalManifest)

    await writeFile(evidencePath, '{}\n')
    const legacy = run(['project-run', '--fixture', fixturePath, projectPath])
    assert.equal(legacy.status, 65)
    assert.ok(legacy.value.diagnostics.some(
      ({ code, path }) =>
        code === 'unlisted-project-file' && path === 'review-evidence.json',
    ))
    await rm(evidencePath, { force: true })

    await symlink(fixturePath, symlinkFixture.path)
    const linked = run(['project-run', '--fixture', symlinkFixture.path, projectPath])
    assert.equal(linked.status, 65)
    assert.equal(linked.value.diagnostics[0].code, 'project-run-fixture-not-regular-file')
  } finally {
    await writeFile(sourcePath, originalSource)
    await writeFile(manifestPath, originalManifest)
    await rm(evidencePath, { force: true })
    await symlinkFixture.cleanup()
  }
})

test('project-run cannot invoke an adapter that the checked function body does not call', async () => {
  const temporary = await mkdtemp(`${tmpdir()}/re-agent-business-body-`)
  await cp(root.pathname, temporary, { recursive: true })
  const selectionPath = join(temporary, '..', `re-agent-business-selection-${process.pid}.json`)
  try {
    const sourcePath = join(temporary, 'modules/intake.re')
    const manifestPath = join(temporary, 'project.json')
    const source = await readFile(sourcePath, 'utf8')
    const mutated = mutateDeclaration(
      source,
      'function-declaration agent.expense.intake.review ',
      (declaration) => {
        declaration.body.capability_calls = []
        declaration.body.effect_edges = []
        declaration.body.control_flow.value.endpoint = 'request.result'
      },
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const digest = sourceDigest(mutated)
    manifest.modules.find(({ name }) => name === 'agent.expense.intake').source_sha256 =
      digest
    manifest.package_manifest.modules.find(
      ({ name }) => name === 'agent.expense.intake',
    ).implementation_digest = digest
    await writeFile(sourcePath, mutated)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const loaded = await loadProjectDirectory(temporary)
    assert.equal(loaded.ok, false)
    assert.ok(loaded.diagnostics.some(
      ({ code }) => code === 'project-run-case-business-body-unsupported',
    ))
  } finally {
    await rm(temporary, { force: true, recursive: true })
    await rm(selectionPath, { force: true })
  }
})

test('project-run adapter injection receives only canonical checked business input', async () => {
  const loaded = await loadProjectDirectory(projectPath)
  assert.equal(loaded.ok, true)
  const calls = []
  const result = await executeProjectRun(loaded.value, fixturePath, {
    adapter_factory: ({ contract }) => ({
      invoke(_operation, input, context) {
        calls.push({ input, request_id: context.request_id })
        return context.request_id.endsWith(':1')
          ? {
              kind: 'value',
              value: {
                error: {
                  type: 'agent.expense.intake.error',
                  variant: 'transient',
                },
                kind: 'err',
              },
            }
          : {
              kind: 'value',
              value: {
                kind: 'ok',
                value: {
                  approved: true,
                  currency: { variant: 'usd' },
                },
              },
            }
      },
      profileIdentity: () => contract.profile,
    }),
  })

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  assert.deepEqual(calls, [
    {
      input: { amount: '125.00', currency: { variant: 'usd' } },
      request_id: 'expense-001:1',
    },
    {
      input: { amount: '125.00', currency: { variant: 'usd' } },
      request_id: 'expense-001:2',
    },
  ])
})

test('project-run loopback HTTP adapter proves retry requests and receipt trace', async () => {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({
      body: Buffer.concat(chunks).toString('utf8'),
      headers: request.headers,
      method: request.method,
      url: request.url,
    })
    const attempt = requests.length
    const payload = attempt === 1
      ? {
        error: {
          type: 'agent.expense.intake.error',
          variant: 'transient',
        },
        kind: 'err',
      }
      : {
        kind: 'ok',
        value: { approved: true, currency: 'usd' },
      }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      kind: payload.kind,
      ...(payload.kind === 'ok'
        ? { value: payload.value }
        : { error: payload.error }),
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  try {
    const loaded = await loadProjectDirectory(projectPath)
    assert.equal(loaded.ok, true)
    const result = await executeProjectRun(loaded.value, fixturePath, {
      adapter_factory: ({ contract }) => new AgentBusinessHttpAdapter({
        contract,
        endpoint: `http://127.0.0.1:${address.port}/expense/review`,
        profile: contract.profile,
        timeout_ms: 1000,
      }),
    })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    assert.deepEqual(requests.map(({ body, method, url }) => ({
      body,
      method,
      url,
    })), [
      {
        body: '{"amount":"125.00","currency":"usd"}',
        method: 'POST',
        url: '/expense/review',
      },
      {
        body: '{"amount":"125.00","currency":"usd"}',
        method: 'POST',
        url: '/expense/review',
      },
    ])
    assert.equal(requests[0].headers['content-type'], 'application/json')
    assert.equal(result.value.task.attempts, 2)
    assert.deepEqual(result.value.typed_outcome, {
      kind: 'ok',
      value: { approved: true, currency: { variant: 'usd' } },
    })
    assert.deepEqual(
      result.value.business.execution_trace.map(
        ({ call, input_digest, outcome_digest, request_id }) => ({
          call,
          input_digest,
          outcome_digest,
          request_id,
        }),
      ),
      [
        {
          call: 'expense_db_read',
          input_digest: 'sha256:8968f16d72cbde810a62aa4b2b955a2e8bc0dd94b379f3703f2fe31528e6fe7b',
          outcome_digest: 'sha256:fb1ff30bbccd0849f34309b0f853714a88927f484a7aef2b7f6056e8a7bbba6c',
          request_id: 'expense-001:1',
        },
        {
          call: 'expense_db_read',
          input_digest: 'sha256:8968f16d72cbde810a62aa4b2b955a2e8bc0dd94b379f3703f2fe31528e6fe7b',
          outcome_digest: 'sha256:1c986814dada57ed613e9eb20d1d276e9c4329202c7cded4dd4366761e6dab07',
          request_id: 'expense-001:2',
        },
      ],
    )
    assert.deepEqual(verifyProjectRunReceipt(
      loaded.value,
      JSON.parse(await readFile(fixturePath, 'utf8')),
      result.value,
    ), { ok: true })
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('project-run SQLite adapter proves database text projection and receipt trace', async () => {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    create table expense_review_decisions (
      request_id text not null,
      amount text not null,
      request_currency text,
      outcome text not null,
      approved integer,
      result_currency text,
      error_variant text
    )
  `)
  database.prepare(`
    insert into expense_review_decisions (
      request_id, amount, request_currency, outcome,
      approved, result_currency, error_variant
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'expense-001:1',
    '125.00',
    'usd',
    'err',
    null,
    null,
    'transient',
  )
  database.prepare(`
    insert into expense_review_decisions (
      request_id, amount, request_currency, outcome,
      approved, result_currency, error_variant
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'expense-001:2',
    '125.00',
    'usd',
    'ok',
    1,
    'usd',
    null,
  )
  try {
    const loaded = await loadProjectDirectory(projectPath)
    assert.equal(loaded.ok, true)
    const result = await executeProjectRun(loaded.value, fixturePath, {
      adapter_factory: ({ contract }) => new AgentBusinessSqliteAdapter({
        contract,
        database,
        database_name: 'expense',
        profile: contract.profile,
      }),
    })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    assert.equal(result.value.task.attempts, 2)
    assert.deepEqual(result.value.typed_outcome, {
      kind: 'ok',
      value: { approved: true, currency: { variant: 'usd' } },
    })
    assert.equal(
      database.prepare(
        'select typeof(request_currency) as kind from expense_review_decisions limit 1',
      ).get().kind,
      'text',
    )
    assert.deepEqual(verifyProjectRunReceipt(
      loaded.value,
      JSON.parse(await readFile(fixturePath, 'utf8')),
      result.value,
    ), { ok: true })
  } finally {
    database.close()
  }
})

test('project-run SQLite file handle preserves receipt authority across an explicit file lifecycle', async () => {
  const root = await mkdtemp(`${tmpdir()}/re-agent-expense-sqlite-file-`)
  const handle = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  handle.database.exec(`
    create table expense_review_decisions (
      request_id text not null,
      amount text not null,
      request_currency text,
      outcome text not null,
      approved integer,
      result_currency text,
      error_variant text
    )
  `)
  handle.database.prepare(`
    insert into expense_review_decisions (
      request_id, amount, request_currency, outcome,
      approved, result_currency, error_variant
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'expense-001:1',
    '125.00',
    'usd',
    'err',
    null,
    null,
    'transient',
  )
  handle.database.prepare(`
    insert into expense_review_decisions (
      request_id, amount, request_currency, outcome,
      approved, result_currency, error_variant
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'expense-001:2',
    '125.00',
    'usd',
    'ok',
    1,
    'usd',
    null,
  )
  try {
    const loaded = await loadProjectDirectory(projectPath)
    assert.equal(loaded.ok, true)
    const result = await executeProjectRun(loaded.value, fixturePath, {
      adapter_factory: ({ contract }) => new AgentBusinessSqliteAdapter({
        contract,
        database: handle.database,
        database_name: 'expense',
        profile: contract.profile,
      }),
    })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    assert.equal(result.value.task.attempts, 2)
    assert.deepEqual(result.value.typed_outcome, {
      kind: 'ok',
      value: { approved: true, currency: { variant: 'usd' } },
    })
    assert.deepEqual(verifyProjectRunReceipt(
      loaded.value,
      JSON.parse(await readFile(fixturePath, 'utf8')),
      result.value,
    ), { ok: true })
  } finally {
    assert.deepEqual(handle.close(), { ok: true })
    await rm(root, { force: true, recursive: true })
  }
})

test('project-run rejects boundary text outside the source-owned currency sum', async () => {
  let requests = 0
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before responding.
    }
    requests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      kind: 'ok',
      value: { approved: true, currency: 'brl' },
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  try {
    const loaded = await loadProjectDirectory(projectPath)
    assert.equal(loaded.ok, true)
    const result = await executeProjectRun(loaded.value, fixturePath, {
      adapter_factory: ({ contract }) => new AgentBusinessHttpAdapter({
        contract,
        endpoint: `http://127.0.0.1:${address.port}/expense/review`,
        profile: contract.profile,
        timeout_ms: 1000,
      }),
    })
    assert.equal(result.ok, false)
    assert.equal(
      result.diagnostics[0].code,
      'business-function-output-invalid',
    )
    assert.equal(requests, 1)
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('project-run selection cannot inject task, adapter, or response authority', async () => {
  const temporary = await temporaryFixture('adapter.json')
  const original = JSON.parse(await readFile(fixturePath, 'utf8'))
  try {
    for (const field of ['task', 'adapter', 'responses']) {
      const injected = structuredClone(original)
      injected[field] = {}
      await writeFile(temporary.path, JSON.stringify(injected))
      const invalid = run(['project-run', '--fixture', temporary.path, projectPath])
      assert.equal(invalid.status, 65, field)
      assert.equal(
        invalid.value.diagnostics[0].code,
        'unexpected-project-run-selection-field',
        field,
      )
    }
  } finally {
    await temporary.cleanup()
  }
})

async function temporaryFixture(name) {
  const directory = await mkdtemp(`${tmpdir()}/re-agent-project-run-fixture-`)
  return {
    cleanup: () => rm(directory, { force: true, recursive: true }),
    path: join(directory, name),
  }
}

function run(args) {
  const result = spawnSync(process.execPath, ['src/cli/re.js', ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  let value
  try {
    value = JSON.parse(result.stdout)
  } catch {
    value = null
  }
  return { ...result, value }
}

function receiptDigest(receipt) {
  const { receipt_digest, ...content } = receipt
  return `sha256:${createHash('sha256').update(canonical(content)).digest('hex')}`
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

function sourceDigest(source) {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`
}

function mutateDeclaration(source, prefix, mutate) {
  const lines = source.split('\n')
  const index = lines.findIndex((line) => line.startsWith(prefix))
  assert.notEqual(index, -1)
  const declaration = JSON.parse(lines[index].slice(prefix.length))
  mutate(declaration)
  lines[index] = `${prefix}${JSON.stringify(declaration)}`
  return lines.join('\n')
}
