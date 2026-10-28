import assert from 'node:assert/strict'
import {
  lstat,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AgentBusinessSqliteAdapter } from '../src/host/agent-business-sqlite-adapter.js'
import { invokeAgentCapability } from '../src/host/agent-adapter-contract.js'
import {
  createServerDbSqliteFileHandle,
} from '../src/host/server-db-sqlite-file.js'

const profile = {
  digest: 'sha256:4ace4315fa907f0bfa8458e88f1d3a10b0a16214e7813b431f6859b43a9b4b2f',
  id: 'server-minimum@0.1.0',
  schema: 're.server-profile@0.1.0',
}

test('explicit SQLite file handle persists the business text boundary across reopen', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-file-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const databasePath = join(root, 'expense.sqlite')
  const first = createServerDbSqliteFileHandle({ database_path: databasePath, root })
  first.database.exec(`
    create table expense_review_decisions (
      request_id text not null,
      amount text not null,
      request_currency text not null,
      outcome text not null,
      approved integer,
      result_currency text,
      error_variant text
    )
  `)
  first.database.prepare(`
    insert into expense_review_decisions (
      request_id, amount, request_currency, outcome,
      approved, result_currency, error_variant
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run('expense-file:1', '125.00', 'usd', 'ok', 1, 'usd', null)
  const firstResult = invoke(first.database, 'expense-file:1')
  assert.deepEqual(firstResult.value.outcome, {
    kind: 'ok',
    value: { approved: true, currency: { variant: 'usd' } },
  })
  assert.deepEqual(first.close(), { ok: true })

  const reopened = createServerDbSqliteFileHandle({
    database_path: databasePath,
    root,
  })
  t.after(() => {
    try {
      reopened.close()
    } catch {
      // The assertion below owns the primary lifecycle result.
    }
  })
  const secondResult = invoke(reopened.database, 'expense-file:1')
  assert.deepEqual(secondResult.value.outcome, firstResult.value.outcome)
  assert.equal((await lstat(databasePath)).isFile(), true)
})

test('SQLite file handle snapshots close authority and rejects repeated close', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-file-close-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const handle = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  let spoofedCalls = 0
  handle.database.close = () => {
    spoofedCalls += 1
  }
  assert.deepEqual(handle.close(), { ok: true })
  assert.deepEqual(handle.close(), { error: 'closed', ok: false })
  assert.equal(spoofedCalls, 0)
})

test('SQLite file handle rejects relative, URL-like, directory, and escaping symlink paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-file-path-'))
  const outside = await mkdtemp(join(tmpdir(), 're-sqlite-file-outside-'))
  t.after(async () => {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(outside, { force: true, recursive: true }),
    ])
  })
  await symlink(join(outside, 'expense.sqlite'), join(root, 'linked.sqlite'))
  const cases = [
    { database_path: 'expense.sqlite', root },
    { database_path: 'sqlite:///tmp/expense.sqlite', root },
    { database_path: root, root },
    { database_path: join(root, 'linked.sqlite'), root },
    { database_path: join(outside, 'expense.sqlite'), root },
  ]
  for (const input of cases) {
    assert.throws(
      () => createServerDbSqliteFileHandle(input),
      (error) => (
        error instanceof TypeError
        && !error.message.includes(root)
        && !error.message.includes(outside)
      ),
    )
  }
})

test('SQLite file handle sanitizes invalid external file content without leaking path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-file-mutation-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const databasePath = join(root, 'expense.sqlite')
  const handle = createServerDbSqliteFileHandle({ database_path: databasePath, root })
  assert.deepEqual(handle.close(), { ok: true })
  await rm(databasePath)
  await writeFile(
    databasePath,
    'not a sqlite database',
    'utf8',
  )
  assert.throws(
    () => createServerDbSqliteFileHandle({ database_path: databasePath, root }),
    (error) => (
      error instanceof TypeError
      && error.message === 'invalid SQLite file handle'
      && !error.message.includes(databasePath)
    ),
  )
})

function invoke(database, requestId) {
  const adapter = new AgentBusinessSqliteAdapter({
    contract: contract(),
    database,
    database_name: 'expense',
    profile,
  })
  return invokeAgentCapability(
    contract(),
    adapter,
    {
      capability_reference: 'db.read@0.1.0',
      cancellation: null,
      deadline: null,
      input: { amount: '125.00', currency: { variant: 'usd' } },
      member: 'read',
      request_id: requestId,
    },
  )
}

function contract() {
  return {
    agent: 'agent.expense.intake',
    capability: {
      instance: '@expense_db',
      member: 'read',
      reference: 'db.read@0.1.0',
    },
    cancellation: { mode: 'cooperative', supported: true },
    deadline: { max_ms: 0, required: false },
    error_type: { kind: 'type', name: 'agent.expense.intake.error' },
    error_variants: ['transient', 'unavailable'],
    features: ['cancellation'],
    input_type: { kind: 'type', name: 'agent.expense.intake.input' },
    module: 'agent.expense.intake',
    node_uid: `${'d'.repeat(25)}e`,
    output_type: { kind: 'type', name: 'agent.expense.intake.result' },
    profile,
    request_type: { kind: 'type', name: 'agent.expense.intake.input' },
    resource: { access: 'read', constructor: 'expense_db' },
    schema: 're.agent-adapter-contract@0.1.0',
  }
}
