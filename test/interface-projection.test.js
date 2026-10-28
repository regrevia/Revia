import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  buildInterfaceProjection,
  verifyInterfaceProjection,
  writeInterfaceProjection,
} from '../src/toolchain/interface-projection.js'
import {
  moduleInterfaceDigest,
} from '../src/toolchain/module-contract.js'
import {
  agentAdapterContractDigest,
} from '../src/host/agent-adapter-contract.js'
import {
  businessFunctionDigest,
  validateBusinessFunction,
} from '../src/toolchain/business-function.js'
import {
  typeDeclarationDigest,
} from '../src/toolchain/type-contract.js'
import { loadProjectDirectory } from '../src/toolchain/project-loader.js'

test('interface projection is deterministic, path-free, and binds route authority', async () => {
  const project = fixtureProject()
  const first = buildInterfaceProjection(project, {
    routes: [route(), route('demo.api.serve_alt')],
  })
  const second = buildInterfaceProjection(structuredClone(project), {
    routes: [route('demo.api.serve_alt'), route()],
  })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.value.contract.schema, 're.interface-projection@0.1.0')
  assert.equal(first.value.contract.authority.graph_revision, project.graph_revision)
  assert.deepEqual(
    first.value.contract.operations.map(({ operation }) => operation.name),
    ['demo.api.serve', 'demo.api.serve_alt'],
  )
  assert.deepEqual(first.value.files, second.value.files)
  assert.equal(first.value.contract.operations[0].authority.interface_digest, project.modules[0].interface_digest)
  assert.equal(first.value.contract.operations[0].route.path, '/v1/expenses')
  assert.equal(first.value.contract.operations[0].route.method, 'GET')
  assert.match(first.value.files['types.ts'], /export interface ExpenseInput/)
  assert.match(first.value.files['client.ts'], /x-revia-graph-revision/)
  assert.match(first.value.files['client.ts'], /idempotency-key-required/)
  assert.doesNotMatch(JSON.stringify(first.value), /\/Users\/|re-project|tmp/)
  assert.equal(JSON.stringify(first.value), JSON.stringify(buildInterfaceProjection(project, {
    routes: [route('demo.api.serve_alt'), route()],
  }).value))

  const root = await mkdtemp(join(tmpdir(), 're-projection-determinism-'))
  const left = join(root, 'left')
  const right = join(root, 'right')
  assert.equal((await writeInterfaceProjection(project, {
    output: left,
    routes: [route('demo.api.serve_alt'), route()],
  })).ok, true)
  assert.equal((await writeInterfaceProjection(project, {
    output: right,
    routes: [route(), route('demo.api.serve_alt')],
  })).ok, true)
  const names = (await readdir(left)).sort()
  assert.deepEqual(names, ['client.ts', 'projection.json', 'types.ts'])
  for (const name of names) {
    assert.equal(
      await readFile(join(left, name), 'utf8'),
      await readFile(join(right, name), 'utf8'),
    )
  }
  const verified = await verifyInterfaceProjection(project, {
    output: left,
    routes: [route(), route('demo.api.serve_alt')],
  })
  assert.equal(verified.ok, true)
  await writeFile(join(left, 'client.ts'), 'handwritten\n')
  const drift = await verifyInterfaceProjection(project, {
    output: left,
    routes: [route()],
  })
  assert.equal(drift.ok, false)
  assert.equal(drift.diagnostics[0].code, 'projection-artifact-drift')
})

test('interface projection rejects an export without exact checked operation authority', () => {
  const project = fixtureProject()
  project.modules[0].interface.exports[0].contract_digest = `sha256:${'f'.repeat(64)}`
  project.modules[0].interface_digest = moduleInterfaceDigest(project.modules[0].interface)
  const result = buildInterfaceProjection(project, { routes: [route()] })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'projection-operation-contract-mismatch')
})

test('interface projection rejects a structurally checked operation with stale declaration digest', () => {
  const project = fixtureProject()
  project.modules[0].function_declarations[0].declaration.body.control_flow = {
    ...project.modules[0].function_declarations[0].declaration.body.control_flow,
    schema: 're.control-flow-graph@0.1.0',
  }
  const result = buildInterfaceProjection(project, { routes: [route()] })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'projection-operation-contract-mismatch')
})

test('interface projection preserves the business digest for its structurally checked form', () => {
  const project = fixtureProject()
  const entry = project.modules[0].function_declarations[0]
  const checked = validateBusinessFunction(entry.declaration)
  assert.equal(checked.ok, true)
  entry.declaration = checked.value

  const result = buildInterfaceProjection(project, { routes: [route()] })

  assert.equal(result.ok, true)
  assert.equal(
    result.value.contract.operations[0].operation.declaration_digest,
    entry.declaration_digest,
  )
})

test('interface projection rejects ambiguous adapter type names instead of guessing a digest', () => {
  const project = fixtureProject()
  const original = project.modules[0].type_declarations[0]
  const duplicate = structuredClone(original)
  duplicate.declaration.body.fields[0].type = { kind: 'primitive', name: 'bytes' }
  duplicate.declaration_digest = typeDeclarationDigest(duplicate.declaration)
  project.modules[0].type_declarations.push(duplicate)
  const functionEntry = project.modules[0].function_declarations[0]
  functionEntry.declaration.input_type = declared(duplicate.declaration_digest)
  functionEntry.declaration.body.capability_calls[0].input_type =
    declared(duplicate.declaration_digest)
  functionEntry.declaration_digest = businessFunctionDigest(functionEntry.declaration)
  project.modules[0].interface.exports[0].contract_digest =
    functionEntry.declaration_digest
  project.modules[0].interface_digest = moduleInterfaceDigest(
    project.modules[0].interface,
  )

  const result = buildInterfaceProjection(project, { routes: [route()] })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'projection-adapter-operation-mismatch')
})

test('interface projection rejects route, error, and revision drift before writing', async () => {
  const project = fixtureProject()
  const output = await mkdtemp(join(tmpdir(), 're-projection-'))
  await writeFile(join(output, 'sentinel.txt'), 'keep\n')

  for (const changed of [
    { ...route(), operation: 'demo.api.missing' },
    { ...route(), error_variants: ['secret_leak'] },
  ]) {
    const result = await writeInterfaceProjection(project, {
      output,
      routes: [changed],
    })
    assert.equal(result.ok, false)
    assert.equal(result.written, false)
  }
  const stale = structuredClone(project)
  stale.graph_revision = `sha256:${'e'.repeat(64)}`
  const staleResult = await writeInterfaceProjection(stale, {
    output,
    graph_revision: project.graph_revision,
    routes: [route()],
  })
  assert.equal(staleResult.ok, false)
  assert.equal(staleResult.diagnostics[0].code, 'projection-graph-revision-mismatch')
  assert.equal(await readFile(join(output, 'sentinel.txt'), 'utf8'), 'keep\n')
})

test('interface projection rejects unknown and recursive type authority', () => {
  const unknown = fixtureProject()
  unknown.modules[0].function_declarations[0].declaration.input_type = {
    arguments: [],
    declaration_digest: `sha256:${'1'.repeat(64)}`,
    kind: 'declared',
  }
  unknown.modules[0].function_declarations[0].declaration_digest =
    businessFunctionDigest(unknown.modules[0].function_declarations[0].declaration)
  unknown.modules[0].interface.exports[0].contract_digest =
    unknown.modules[0].function_declarations[0].declaration_digest
  unknown.modules[0].interface_digest = moduleInterfaceDigest(unknown.modules[0].interface)
  let result = buildInterfaceProjection(unknown, { routes: [route()] })
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'projection-type-declaration-not-found')

  const recursive = fixtureProject()
  const recursiveDeclaration = {
    body: {
      fields: [{
        name: 'next',
        type: { kind: 'option', value: { kind: 'self' } },
      }],
      kind: 'record',
    },
    module: 'demo.api',
    name: 'recursive',
    parameters: [],
    schema: 're.type-declaration@0.1.0',
  }
  const recursiveDigest = typeDeclarationDigest(recursiveDeclaration)
  recursive.modules[0].type_declarations.push({
    declaration: recursiveDeclaration,
    declaration_digest: recursiveDigest,
    name: 'demo.api.recursive',
  })
  recursive.modules[0].function_declarations[0].declaration.input_type = {
    arguments: [],
    declaration_digest: recursiveDigest,
    kind: 'declared',
  }
  recursive.modules[0].function_declarations[0].declaration_digest =
    businessFunctionDigest(recursive.modules[0].function_declarations[0].declaration)
  recursive.modules[0].interface.exports[0].contract_digest =
    recursive.modules[0].function_declarations[0].declaration_digest
  recursive.modules[0].interface_digest = moduleInterfaceDigest(
    recursive.modules[0].interface,
  )
  result = buildInterfaceProjection(recursive, { routes: [route()] })
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'projection-recursive-type-unsupported')
})

test('interface projection rejects an operation outside the checked module graph', () => {
  const project = fixtureProject()
  const result = buildInterfaceProjection(project, {
    routes: [route(), route('demo.other.serve')],
  })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'projection-operation-module-not-found')
})

test('interface projection rejects colliding generated client method names', () => {
  const project = fixtureProject()
  const secondModule = structuredClone(project.modules[0])
  secondModule.name = 'demo.other'
  secondModule.interface.module = 'demo.other'
  secondModule.type_declarations = []
  secondModule.interface_digest = moduleInterfaceDigest(secondModule.interface)
  secondModule.function_declarations[0].name = 'demo.other.serve'
  secondModule.adapter_contracts[0].name = 'demo.other.expense_api'
  secondModule.adapter_contracts[0].contract.module = 'demo.other'
  secondModule.adapter_contracts[0].contract.agent = 'demo.other'
  secondModule.adapter_contracts[0].contract_digest =
    agentAdapterContractDigest(secondModule.adapter_contracts[0].contract)
  project.modules.push(secondModule)

  const result = buildInterfaceProjection(project, {
    routes: [
      route(),
      {
        ...route('demo.other.serve'),
        adapter: 'demo.other.expense_api',
      },
    ],
  })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'projection-client-method-name-collision')
})

test('interface projection emits optional idempotency without requiring a key', () => {
  const optional = {
    ...route(),
    idempotency: { mode: 'optional' },
  }
  const result = buildInterfaceProjection(fixtureProject(), {
    routes: [optional],
  })

  assert.equal(result.ok, true)
  assert.doesNotMatch(result.value.files['client.ts'], /idempotency-key-required/)
  assert.match(result.value.files['client.ts'], /options\.idempotencyKey !== undefined/)
})

test('generated client uses the Server profile header wire format and rejects unsafe values', () => {
  const result = buildInterfaceProjection(fixtureProject(), {
    routes: [{
      ...route(),
      auth: { mode: 'bearer' },
    }],
  })

  assert.equal(result.ok, true)
  assert.match(result.value.files['client.ts'], /headers\.join\('\\n'\)/)
  assert.doesNotMatch(result.value.files['client.ts'], /headers\.join\(';'\)/)
  assert.match(result.value.files['client.ts'], /invalid-header-value/)
  assert.match(result.value.files['client.ts'], /hasUnpairedSurrogate/)
})

test('generated client validates response JSON before returning typed values', () => {
  const result = buildInterfaceProjection(fixtureProject(), { routes: [route()] })

  assert.equal(result.ok, true)
  assert.match(result.value.files['client.ts'], /response-contract-mismatch/)
  assert.match(result.value.files['client.ts'], /decodeJson/)
  assert.match(result.value.files['client.ts'], /isExpenseOutput/)
  assert.match(result.value.files['client.ts'], /isExpenseError/)
  assert.doesNotMatch(result.value.files['client.ts'], /function is[a-z][a-z0-9_]*\./u)
})

test('project-projection CLI emits byte-identical checked-project artifacts across fresh processes', async (context) => {
  const project = await createProjectionProject()
  context.after(() => rm(project.workspace, { force: true, recursive: true }))
  const loaded = await loadProjectDirectory(project.root)
  assert.equal(loaded.ok, true)
  const routes = join(project.workspace, 'routes.json')
  const left = join(project.workspace, 'left')
  const right = join(project.workspace, 'right')
  await writeFile(routes, JSON.stringify({
    graph_revision: loaded.value.graph_revision,
    routes: [project.route],
    schema: 're.interface-projection-routes@0.1.0',
  }))
  const cli = fileURLToPath(new URL('../src/cli/re.js', import.meta.url))
  const run = (output) => spawnSync(process.execPath, [
    cli,
    'project-projection',
    '--routes',
    routes,
    '--out',
    output,
    project.root,
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' })
  const first = run(left)
  const second = run(right)

  assert.equal(first.status, 0, `${first.stderr}${first.stdout}`)
  assert.equal(second.status, 0, `${second.stderr}${second.stdout}`)
  assert.equal(first.stderr, '')
  assert.equal(second.stderr, '')
  assert.equal(first.stdout, second.stdout)
  assert.doesNotMatch(first.stdout, new RegExp(
    project.root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
  ))
  for (const name of ['client.ts', 'projection.json', 'types.ts']) {
    const firstSource = await readFile(join(left, name), 'utf8')
    const secondSource = await readFile(join(right, name), 'utf8')
    assert.equal(firstSource, secondSource)
    assert.doesNotMatch(firstSource, new RegExp(
      project.root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
    ))
  }
  assert.match(await readFile(join(left, 'types.ts'), 'utf8'), /export interface Input/)
  assert.match(await readFile(join(left, 'client.ts'), 'utf8'), /async review\(/)

  const verified = await verifyInterfaceProjection(loaded.value, {
    graph_revision: loaded.value.graph_revision,
    output: left,
    routes: [project.route],
  })
  assert.equal(verified.ok, true)
  await writeFile(join(left, 'unexpected.txt'), 'drift\n')
  const extra = await verifyInterfaceProjection(loaded.value, {
    graph_revision: loaded.value.graph_revision,
    output: left,
    routes: [project.route],
  })
  assert.equal(extra.ok, false)
  assert.equal(extra.diagnostics[0].code, 'projection-artifact-file-set-drift')
})

test('interface projection refuses a symlinked output directory before writing', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 're-projection-symlink-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  const target = join(root, 'target')
  const output = join(root, 'output')
  await mkdir(target)
  await symlink(target, output)

  const result = await writeInterfaceProjection(fixtureProject(), {
    output,
    routes: [route()],
  })

  assert.equal(result.ok, false)
  assert.equal(result.written, false)
  assert.equal(result.diagnostics[0].code, 'projection-output-symlink')
})

async function createProjectionProject() {
  const workspace = await mkdtemp(join(tmpdir(), 're-projection-project-'))
  const root = join(workspace, 'project')
  await mkdir(join(root, 'modules'), { recursive: true })
  const fixtureRoot = fileURLToPath(new URL('./fixtures/agent-expense-review/', import.meta.url))
  const fixtureManifest = JSON.parse(await readFile(
    join(fixtureRoot, 'project.json'),
    'utf8',
  ))
  const source = (await readFile(join(fixtureRoot, 'modules/intake.re'), 'utf8'))
    .replace(/^import[^\n]*\n/m, '')
    .replace(/^export accept$/mu, 'export review')
  const sourceSha256 = `sha256:${createHash('sha256').update(source).digest('hex')}`
  const fixtureProject = await loadProjectDirectory(fixtureRoot)
  assert.equal(fixtureProject.ok, true)
  const intake = fixtureProject.value.modules.find(
    ({ name }) => name === 'agent.expense.intake',
  )
  const review = intake.function_declarations.find(
    ({ name }) => name === 'agent.expense.intake.review',
  )
  const moduleInterface = {
    dependencies: [],
    exports: [{
      contract_digest: review.declaration_digest,
      kind: 'function',
      name: 'review',
    }],
    module: 'agent.expense.intake',
    schema: 're.module-interface@0.1.0',
  }
  const packageManifest = {
    external_interfaces: [],
    modules: [{
      implementation_digest: sourceSha256,
      interface: moduleInterface,
      interface_digest: moduleInterfaceDigest(moduleInterface),
      name: 'agent.expense.intake',
    }],
    package: 'agent.expense',
    schema: 're.package-manifest@0.1.0',
  }
  await writeFile(join(root, 'modules/intake.re'), source)
  await writeFile(join(root, 'project.json'), `${JSON.stringify({
    agents: fixtureManifest.agents,
    allowed_capabilities: ['db.read@0.1.0'],
    modules: [{
      name: 'agent.expense.intake',
      path: 'modules/intake.re',
      source_sha256: sourceSha256,
    }],
    package_manifest: packageManifest,
    resources: [{
      alias: 'expense_db',
      key: 'expense_db',
      uid: 'ggggggggggggggggggggggggge',
    }],
    schema: 're.project-manifest@0.1.0',
  })}\n`)
  return {
    root,
    workspace,
    route: {
      adapter: 'agent.expense.intake.db',
      auth: { mode: 'none' },
      error_variants: ['transient', 'unavailable'],
      idempotency: { mode: 'required' },
      method: 'POST',
      operation: 'agent.expense.intake.review',
      path: '/v1/expense/review',
      success_status: 200,
    },
  }
}

function fixtureProject() {
  const input = declaration('expense_input', {
    fields: [{
      name: 'amount',
      type: { kind: 'primitive', name: 'text.utf8' },
    }],
    kind: 'record',
  })
  const output = declaration('expense_output', {
    fields: [{
      name: 'accepted',
      type: { kind: 'primitive', name: 'bool' },
    }],
    kind: 'record',
  })
  const error = declaration('expense_error', {
    kind: 'sum',
    variants: [
      { name: 'invalid_input' },
      { name: 'unavailable' },
    ],
  })
  const declarations = [input, output, error].map((value) => ({
    declaration: value,
    declaration_digest: typeDeclarationDigest(value),
    name: `demo.api.${value.name}`,
  }))
  const inputType = declared(declarations[0].declaration_digest)
  const outputType = declared(declarations[1].declaration_digest)
  const errorType = declared(declarations[2].declaration_digest)
  const functionDeclaration = {
    body: {
      calls: [],
      capability_calls: [{
        capability: {
          instance: '@expense_api',
          member: 'invoke',
          reference: 'http.request@0.1.0',
        },
        error_type: errorType,
        id: 'invoke',
        input_type: inputType,
        node_uid: `${'a'.repeat(25)}e`,
        output_type: outputType,
        resource: { access: 'write', constructor: 'expense_api' },
      }],
      control_flow: {
        kind: 'result-flow',
        propagation: false,
        schema: 're.control-flow-contract@0.1.0',
        uses: [{ kind: 'match', variants: ['err', 'ok'] }],
        value: {
          endpoint: 'invoke.result',
          type: { kind: 'sum', variants: ['err', 'ok'] },
        },
      },
      effect_edges: [{
        access: 'write',
        call: 'invoke',
        from: 'request',
        resource: 'expense_api',
        to: 'invoke',
      }],
    },
    error_type: errorType,
    input_type: inputType,
    module: 'demo.api',
    name: 'serve',
    output_type: outputType,
    schema: 're.function-declaration@0.1.0',
  }
  const functionDigest = businessFunctionDigest(functionDeclaration)
  const alternateFunctionDeclaration = {
    ...structuredClone(functionDeclaration),
    name: 'serve_alt',
  }
  const alternateFunctionDigest = businessFunctionDigest(
    alternateFunctionDeclaration,
  )
  const moduleInterface = {
    dependencies: [],
    exports: [
      {
        contract_digest: functionDigest,
        kind: 'function',
        name: 'serve',
      },
      {
        contract_digest: alternateFunctionDigest,
        kind: 'function',
        name: 'serve_alt',
      },
    ],
    module: 'demo.api',
    schema: 're.module-interface@0.1.0',
  }
  const adapter = {
    agent: 'demo.api',
    capability: {
      instance: '@expense_api',
      member: 'invoke',
      reference: 'http.request@0.1.0',
    },
    cancellation: { mode: 'cooperative', supported: true },
    deadline: { max_ms: 1000, required: false },
    error_type: { kind: 'type', name: 'demo.api.expense_error' },
    error_variants: ['invalid_input', 'unavailable'],
    features: ['cancellation', 'deadline'],
    input_type: { kind: 'type', name: 'demo.api.expense_input' },
    module: 'demo.api',
    node_uid: `${'a'.repeat(25)}e`,
    output_type: { kind: 'type', name: 'demo.api.expense_output' },
    profile: {
      digest: `sha256:${'2'.repeat(64)}`,
      id: 'server-minimum@0.1.0',
      schema: 're.server-profile@0.1.0',
    },
    request_type: { kind: 'type', name: 'demo.api.expense_input' },
    resource: { access: 'write', constructor: 'expense_api' },
    schema: 're.agent-adapter-contract@0.1.0',
  }
  const adapterDigest = agentAdapterContractDigest(adapter)
  const module = {
    adapter_contracts: [{
      contract: adapter,
      contract_digest: adapterDigest,
      name: 'demo.api.expense_api',
    }],
    function_declarations: [{
      declaration: functionDeclaration,
      declaration_digest: functionDigest,
      name: 'demo.api.serve',
    }, {
      declaration: alternateFunctionDeclaration,
      declaration_digest: alternateFunctionDigest,
      name: 'demo.api.serve_alt',
    }],
    implementation_digest: `sha256:${'4'.repeat(64)}`,
    interface: moduleInterface,
    interface_digest: moduleInterfaceDigest(moduleInterface),
    module_surface_digest: `sha256:${'5'.repeat(64)}`,
    name: 'demo.api',
    source_sha256: `sha256:${'4'.repeat(64)}`,
    type_declarations: declarations,
  }
  return {
    agents: [],
    graph_revision: `sha256:${'6'.repeat(64)}`,
    modules: [module],
    package_digest: `sha256:${'7'.repeat(64)}`,
    project_digest: `sha256:${'8'.repeat(64)}`,
    schema: 're.project-graph@0.1.0',
  }
}

function route(operation = 'demo.api.serve') {
  return {
    adapter: 'demo.api.expense_api',
    auth: { mode: 'none' },
    error_variants: ['invalid_input', 'unavailable'],
    idempotency: { mode: 'required' },
    method: 'GET',
    operation,
    path: operation.endsWith('_alt') ? '/v1/expenses/alt' : '/v1/expenses',
    success_status: 200,
  }
}

function declaration(name, body) {
  return {
    body,
    module: 'demo.api',
    name,
    parameters: [],
    schema: 're.type-declaration@0.1.0',
  }
}

function declared(declarationDigest) {
  return { arguments: [], declaration_digest: declarationDigest, kind: 'declared' }
}
