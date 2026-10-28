import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('../examples/agent-expense-review/', import.meta.url)
const projectPath = root.pathname

test('materialized Agent project checks and translates across locales and media', async () => {
  const checked = run(['project-check', '--format', 'json', projectPath])
  assert.equal(checked.status, 0, checked.stderr)
  assert.equal(checked.value.ok, true)
  assert.equal(checked.value.graph.graph_revision, checked.value.graph.project_digest)

  const outputs = new Map()
  for (const locale of ['zh-CN', 'en-US']) {
    for (const format of ['json', 'text', 'html', 'svg']) {
      const result = run([
        'project-translate',
        '--locale',
        locale,
        '--format',
        format,
        projectPath,
      ])
      assert.equal(result.status, 0, `${locale}/${format}: ${result.stderr}`)
      outputs.set(`${locale}/${format}`, result)
    }
  }

  const jsonZh = outputs.get('zh-CN/json').value.project
  const jsonEn = outputs.get('en-US/json').value.project
  assert.equal(jsonZh.receipt.graph_revision, checked.value.graph.graph_revision)
  assert.equal(jsonZh.receipt.semantic_fact_digest, jsonEn.receipt.semantic_fact_digest)
  assert.deepEqual(jsonZh.receipt.fact_ids, jsonEn.receipt.fact_ids)
  assert.ok(jsonZh.facts.some(({ kind }) => kind === 'capability'))
  assert.ok(jsonZh.facts.some(({ kind }) => kind === 'resource'))
  assert.ok(jsonZh.facts.some(({ kind }) => kind === 'task'))
  assert.ok(jsonZh.facts.some(({ kind }) => kind === 'task-contract'))
  assert.ok(jsonZh.facts.some(({ kind }) => kind === 'adapter-contract'))
  assert.ok(jsonZh.facts.some(({ kind }) => kind === 'run-case'))
  assert.ok(jsonZh.facts.some(({ kind }) => kind === 'type-declaration'))
  assert.ok(jsonZh.facts.some(({ kind }) => kind === 'function-declaration'))
  const currencyFactId =
    'fact:project/module/agent.expense.intake/type/agent.expense.intake.currency'
  const currencyZh = jsonZh.facts.find(({ fact_id }) => fact_id === currencyFactId)
  const currencyEn = jsonEn.facts.find(({ fact_id }) => fact_id === currencyFactId)
  assert.equal(currencyZh.summary, currencyEn.summary)
  assert.match(currencyZh.summary, /"variants":\[\{"name":"usd"\},\{"name":"cny"\}\]/)
  assert.ok(checked.value.graph.modules.every(({ surface }) =>
    [
      're.module-surface-lowering@0.2.0',
      're.module-surface-lowering@0.3.0',
      're.module-surface-lowering@0.4.0',
    ]
      .includes(surface.schema)))
  assert.deepEqual(
    checked.value.graph.modules[0].states,
    checked.value.graph.modules[0].surface.states,
  )
  assert.deepEqual(
    checked.value.graph.modules[0].tasks,
    checked.value.graph.modules[0].surface.tasks,
  )
  assert.deepEqual(
    checked.value.graph.modules[0].edges,
    checked.value.graph.modules[0].surface.edges,
  )

  for (const locale of ['zh-CN', 'en-US']) {
    const json = outputs.get(`${locale}/json`).value.project
    for (const format of ['text', 'html', 'svg']) {
      const body = outputs.get(`${locale}/${format}`).stdout
      assert.match(body, new RegExp(json.receipt.graph_revision))
      assert.match(body, new RegExp(json.receipt.semantic_fact_digest))
    }
  }
})

test('materialized project source facts control graph identity and legacy sidecars fail closed', async () => {
  const temporary = await mkdtemp(`${tmpdir()}/re-agent-expense-review-check-`)
  await cp(root.pathname, temporary, { recursive: true })
  try {
    const baseline = run(['project-check', '--format', 'json', temporary])
    assert.equal(baseline.status, 0, baseline.stderr)

    const sourcePath = join(temporary, 'modules/domain.re')
    const manifestPath = join(temporary, 'project.json')
    const source = await readFile(sourcePath, 'utf8')
    const mutated = source.replace(
      'state ready uid oooooooooooooooooooooooooe',
      'state reviewed uid oooooooooooooooooooooooooe',
    )
    assert.notEqual(mutated, source)
    const sourceSha256 = sourceDigest(mutated)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.modules.find(({ name }) => name === 'agent.expense.domain').source_sha256 =
      sourceSha256
    manifest.package_manifest.modules.find(
      ({ name }) => name === 'agent.expense.domain',
    ).implementation_digest = sourceSha256
    await writeFile(sourcePath, mutated)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const changed = run(['project-check', '--format', 'json', temporary])
    assert.equal(changed.status, 0, changed.stderr)
    assert.notEqual(
      changed.value.graph.graph_revision,
      baseline.value.graph.graph_revision,
    )
    assert.deepEqual(
      changed.value.graph.modules[0].states,
      [{ name: 'reviewed', uid: 'oooooooooooooooooooooooooe' }],
    )

    await writeFile(join(temporary, 'review-evidence.json'), '{}\n')
    const legacy = run(['project-check', '--format', 'json', temporary])
    assert.equal(legacy.status, 65)
    assert.equal(legacy.value.ok, false)
    assert.ok(legacy.value.diagnostics.some(
      ({ code, path }) =>
        code === 'unlisted-project-file' && path === 'review-evidence.json',
    ))
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }

  const unsupported = spawnSync(process.execPath, [
    'src/cli/re.js',
    'project-translate',
    '--locale',
    'fr-FR',
    '--format',
    'html',
    projectPath,
  ], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  assert.equal(unsupported.status, 64)
})

test('materialized execution contracts reject missing, mismatched, and duplicate authority', async () => {
  const cases = [
    {
      code: 'project-run-case-contract-not-found',
      mutate: (source) => source.replace(
        '"task":"agent.expense.intake.task"}',
        '"task":"agent.expense.intake.missing"}',
      ),
      name: 'missing task contract',
    },
    {
      code: 'project-type-reference-not-found',
      mutate: (source) => source.replace(
        'sha256:4591984d6746485ac6a0501ab798606c74bd39802b501714f907cdc2363c4068',
        `sha256:${'f'.repeat(64)}`,
      ),
      name: 'unresolved nominal type',
    },
    {
      code: 'project-function-call-not-found',
      mutate: (source) => source.replace(
        '"calls":[]',
        '"calls":["agent.expense.missing"]',
      ),
      name: 'missing business function call',
    },
    {
      code: 'project-agent-authority-mismatch',
      mutate: (source) => source.replace(
        '"retryable_states":["retry_wait"]',
        '"retryable_states":[]',
      ),
      name: 'source and manifest Agent mismatch',
    },
    {
      code: 'project-run-case-capability-type-mismatch',
      mutate: (source) => mutateDeclaration(
        source,
        'adapter-contract agent.expense.intake.db ',
        (declaration) => {
          declaration.output_type.name = 'agent.expense.intake.input'
        },
      ),
      name: 'adapter named output type drift',
    },
    {
      code: 'project-function-capability-not-declared',
      mutate: (source) => source.replace(
        '"member":"read","reference":"db.read@0.1.0"',
        '"member":"write","reference":"db.write@0.1.0"',
      ),
      name: 'capability mismatch',
    },
    {
      code: 'invalid-module-function-declaration',
      mutate: (source) => source.replace(
        '"constructor":"expense_db"',
        '"constructor":"missing_db"',
      ),
      name: 'resource mismatch',
    },
    {
      code: 'invalid-module-function-declaration',
      mutate: (source) => source.replace(
        '"access":"read","constructor":"expense_db"',
        '"access":"write","constructor":"expense_db"',
      ),
      name: 'resource access mismatch',
    },
    {
      code: 'duplicate-project-run-case-response',
      mutate: (source) => source.replace(
        '"amount":"125.00","attempt":2,"currency":{"variant":"usd"}',
        '"amount":"125.00","attempt":1,"currency":{"variant":"usd"}',
      ),
      name: 'duplicate response key',
    },
    {
      code: 'project-run-case-response-contract-mismatch',
      mutate: (source) => source.replace(
        '"variant":"transient"',
        '"variant":"undeclared"',
      ),
      name: 'undeclared response error',
    },
  ]

  for (const entry of cases) {
    const temporary = await mkdtemp(`${tmpdir()}/re-agent-execution-contract-`)
    await cp(root.pathname, temporary, { recursive: true })
    try {
      const sourcePath = join(temporary, 'modules/intake.re')
      const manifestPath = join(temporary, 'project.json')
      const original = await readFile(sourcePath, 'utf8')
      const mutated = entry.mutate(original)
      assert.notEqual(mutated, original, entry.name)
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const digest = sourceDigest(mutated)
      manifest.modules.find(({ name }) => name === 'agent.expense.intake').source_sha256 =
        digest
      manifest.package_manifest.modules.find(
        ({ name }) => name === 'agent.expense.intake',
      ).implementation_digest = digest
      await writeFile(sourcePath, mutated)
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      const result = run(['project-check', '--format', 'json', temporary])
      assert.equal(result.status, 65, entry.name)
      assert.ok(
        result.value.diagnostics.some(({ code }) => code === entry.code),
        `${entry.name}: ${JSON.stringify(result.value.diagnostics)}`,
      )
    } finally {
      await rm(temporary, { force: true, recursive: true })
    }
  }
})

function sourceDigest(source) {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`
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

function mutateDeclaration(source, prefix, mutate) {
  const lines = source.split('\n')
  const index = lines.findIndex((line) => line.startsWith(prefix))
  assert.notEqual(index, -1)
  const declaration = JSON.parse(lines[index].slice(prefix.length))
  mutate(declaration)
  lines[index] = `${prefix}${JSON.stringify(declaration)}`
  return lines.join('\n')
}
