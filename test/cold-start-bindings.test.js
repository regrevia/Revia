import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { serializeCanonicalGraph } from '../src/toolchain/canonical.js'
import { checkProgram } from '../src/toolchain/checker.js'
import { commit, createGraph } from '../src/toolchain/creation-transaction.js'
import { parseExecutableSource } from '../src/toolchain/executable-source.js'
import {
  packageManifestDigest,
  resolveModuleImport,
  validatePackageManifest,
} from '../src/toolchain/module-contract.js'
import { demoSchemaDefinitions } from '../src/host/demo-schema.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'
import { applyStructuredPatch, graphRevision } from '../src/toolchain/structured-patch.js'

const repository = new URL('../', import.meta.url)
const repositoryPath = fileURLToPath(repository)
const cli = fileURLToPath(new URL('../src/cli/re.js', import.meta.url))
const pack = JSON.parse(await readFile(
  new URL('./fixtures/cold-start-tasks.json', import.meta.url),
  'utf8',
))
const canonicalCorpus = JSON.parse(await readFile(
  new URL('./fixtures/canonical-corpus.json', import.meta.url),
  'utf8',
))
const registry = SchemaRegistry.load(demoSchemaDefinitions()).value

test('G6-001 and G6-002 are byte-bound to current CLI goldens', async () => {
  for (const taskId of ['G6-001', 'G6-002']) {
    const task = taskById(taskId)
    const source = await readFile(new URL(task.input_fixture.reference, repository))
    assert.equal(sha256(source), task.input_fixture.sha256)

    const result = spawnSync(process.execPath, [cli, ...task.oracle.arguments], {
      cwd: repositoryPath,
      encoding: 'utf8',
    })
    const golden = await readFile(new URL(task.oracle.golden, repository), 'utf8')
    assert.equal(result.status, task.oracle.exit_status)
    assert.equal(result.stdout, golden)
    assert.equal(result.stderr, '')
  }
})

test('G6-003 binds cross-module to exact interface resolution success', async () => {
  const task = taskById('G6-003')
  const source = await readFile(new URL(task.input_fixture.reference, repository))
  assert.equal(sha256(source), task.input_fixture.sha256)
  const manifest = JSON.parse(source).manifest
  const checkResult = validatePackageManifest(manifest)
  assert.deepEqual(checkResult, { ok: true })
  const fromModule = manifest.modules.find(({ name }) => name === task.oracle.from_module)
  const dependency = fromModule.interface.dependencies.find(
    ({ binding }) => binding === task.oracle.binding,
  )
  const target = manifest.modules.find(({ name }) => name === dependency.module)
  const resolved = resolveModuleImport(
    manifest,
    task.oracle.from_module,
    task.oracle.binding,
    task.oracle.export,
  )
  assert.equal(resolved.ok, true)
  const actual = {
    check_result: checkResult,
    dependency,
    module_interface: target.interface,
    package_manifest_digest: packageManifestDigest(manifest),
    resolved_symbol: resolved.reference,
    schema: 're.g6-cross-module-oracle@0.1.0',
  }
  const golden = JSON.parse(await readFile(new URL(task.oracle.golden, repository)))
  assert.deepEqual(actual, golden)
})

test('G6-004 binds stale revision rejection to an unchanged canonical graph', async () => {
  const task = taskById('G6-004')
  const graphCase = canonicalCorpus.graph_cases.find(({ id }) =>
    task.input_fixture.reference.endsWith(`#${id}`),
  )
  const source = await readFile(new URL(graphCase.fixture, repository), 'utf8')
  const parsed = parseExecutableSource(source, { file: graphCase.fixture })
  assert.equal(parsed.ok, true)
  const checked = commit(createGraph(parsed.value, {
    check: (graph) => checkProgram(graph, { file: graphCase.fixture, registry }),
    uidFactory: deterministicUidFactory(),
  }))
  assert.equal(checked.ok, true)
  const before = serializeCanonicalGraph(checked.program)
  assert.equal(sha256(before), task.input_fixture.sha256)

  const result = applyStructuredPatch(checked.program, {
    baseRevision: task.oracle.base_revision,
    operations: [{
      callUid: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      expectedOldEndpoint: 'baaaaaaaaaaaaaaaaaaaaaaaaa',
      kind: 'replace-input',
      newEndpoint: 'caaaaaaaaaaaaaaaaaaaaaaaaa',
      parameterName: 'data',
    }],
    schema: 're.structured-patch@0.1.0',
  }, {
    check: (graph) => checkProgram(graph, { file: graphCase.fixture, registry }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, task.oracle.diagnostic)
  assert.equal(result.diagnostics[0].actual, graphRevision(checked.program))
  assert.equal(result.diagnostics[0].expected, task.oracle.base_revision)
  assert.equal(serializeCanonicalGraph(checked.program), before)
})

function taskById(id) {
  return pack.tasks.find((task) => task.id === id)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function deterministicUidFactory() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let counter = 0
  return () => {
    let value = counter
    counter += 1
    let prefix = ''
    for (let index = 0; index < 7; index += 1) {
      prefix = alphabet[value % 32] + prefix
      value = Math.floor(value / 32)
    }
    return `${prefix}${'a'.repeat(19)}`
  }
}
