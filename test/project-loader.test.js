import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  moduleInterfaceDigest,
  packageManifestDigest,
} from '../src/toolchain/module-contract.js'
import { loadProjectDirectory } from '../src/toolchain/project-loader.js'
import {
  canonicalizeValue,
  typeDeclarationDigest,
} from '../src/toolchain/type-contract.js'

test('project loader checks source surfaces and emits a root-independent DAG', async () => {
  const firstRoot = await createProject()
  const secondRoot = await createProject()

  const first = await loadProjectDirectory(firstRoot)
  const second = await loadProjectDirectory(secondRoot)

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.value.schema, 're.project-graph@0.1.0')
  assert.equal(first.value.modules.map(({ name }) => name).join(','), 'agent.demo.core,agent.demo.api')
  assert.equal(first.value.modules[1].surface.module, 'agent.demo.api')
  assert.equal(first.value.package_digest, packageManifestDigest(first.value.package_manifest))
  assert.equal(first.value.graph_revision, second.value.graph_revision)
  assert.equal(first.value.project_digest, second.value.project_digest)
  assert.notEqual(first.value.modules[0].relative_path, undefined)
})

test('project loader rejects path escape before reading a module', async () => {
  const root = await createProject()
  const manifest = JSON.parse(await readFile(join(root, 'project.json')))
  manifest.modules[0].path = '../outside.re'
  await writeFile(join(root, 'project.json'), `${JSON.stringify(manifest)}\n`)

  const result = await loadProjectDirectory(root)

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'project-module-path-escapes-root')
})

test('project loader rejects source digest drift and unlisted files', async () => {
  const root = await createProject()
  await writeFile(join(root, 'notes.txt'), 'not declared\n')
  const manifest = JSON.parse(await readFile(join(root, 'project.json')))
  manifest.modules[0].source_sha256 = `sha256:${'f'.repeat(64)}`
  await writeFile(join(root, 'project.json'), `${JSON.stringify(manifest)}\n`)

  const result = await loadProjectDirectory(root)

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ['project-module-source-digest-mismatch', 'unlisted-project-file'],
  )
})

test('project loader closes missing module, duplicate module, and package cycle', async () => {
  const root = await createProject()
  const manifest = JSON.parse(await readFile(join(root, 'project.json')))
  manifest.modules[1].path = 'modules/missing.re'
  manifest.package_manifest.modules[0].interface.dependencies.push({
    binding: 'api',
    interface_digest: manifest.package_manifest.modules[1].interface_digest,
    module: 'agent.demo.api',
    scope: 'package',
  })
  manifest.package_manifest.modules[0].interface_digest = moduleInterfaceDigest(
    manifest.package_manifest.modules[0].interface,
  )
  manifest.package_manifest.modules[0].implementation_digest =
    manifest.modules[0].source_sha256
  await writeFile(join(root, 'project.json'), `${JSON.stringify(manifest)}\n`)

  const result = await loadProjectDirectory(root)

  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(({ code }) => code === 'project-module-source-missing'))
  assert.ok(result.diagnostics.some(({ code }) => code === 'module-dependency-cycle'))
})

test('project loader derives review facts from module source without a semantic sidecar', async () => {
  const root = await createProject()
  const manifest = JSON.parse(await readFile(join(root, 'project.json')))
  const sourcePath = join(root, 'modules/core.re')
  const source = [
    're 1.0 compact',
    'module agent.demo.core',
    'export normalize',
    `capability agent.demo.core.db read db.read@0.1.0 uid ${uid('a')}`,
    `error agent.demo.core.error uid ${uid('2')}`,
    `state ready uid ${uid('o')}`,
    `task agent.demo.core.task id ${digest('a')}`,
    `edge agent.demo.core.input -> agent.demo.core.output uid ${uid('h')}`,
    '',
  ].join('\n')
  const sourceSha256 = sourceDigest(source)
  manifest.allowed_capabilities = ['db.read@0.1.0']
  manifest.resources = [{ alias: 'expense_db', key: 'expense_db', uid: uid('f') }]
  manifest.modules[0].source_sha256 = sourceSha256
  manifest.package_manifest.modules[0].implementation_digest = sourceSha256
  await writeFile(sourcePath, source)
  await writeFile(join(root, 'project.json'), `${JSON.stringify(manifest)}\n`)

  const result = await loadProjectDirectory(root)

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.allowed_capabilities, ['db.read@0.1.0'])
  assert.deepEqual(result.value.resources, manifest.resources)
  assert.deepEqual(result.value.modules[0].states, [{ name: 'ready', uid: uid('o') }])
  assert.deepEqual(result.value.modules[0].tasks, [{
    name: 'agent.demo.core.task',
    task_id: digest('a'),
  }])
  assert.deepEqual(result.value.modules[0].surface.capabilities, [{
    instance: 'agent.demo.core.db',
    member: 'read',
    reference: 'db.read@0.1.0',
    uid: uid('a'),
  }])
  assert.equal(result.value.review_evidence, undefined)
})

test('project loader keeps same local closed-sum names module-scoped', async () => {
  const root = await createProject()
  const manifest = JSON.parse(await readFile(join(root, 'project.json')))
  const declarations = [
    currencyDeclaration('agent.demo.core', ['usd', 'cny']),
    currencyDeclaration('agent.demo.api', ['brl']),
  ]

  for (let index = 0; index < declarations.length; index += 1) {
    const module = manifest.modules[index]
    const packageModule = manifest.package_manifest.modules[index]
    const sourcePath = join(root, module.path)
    const source = await readFile(sourcePath, 'utf8')
    const declaration = declarations[index]
    const updated = source.replace(
      '\nexport ',
      `\ntype-declaration ${declaration.module}.currency ${JSON.stringify(declaration)}\nexport `,
    )
    const digest = sourceDigest(updated)
    module.source_sha256 = digest
    packageModule.implementation_digest = digest
    await writeFile(sourcePath, updated)
  }
  await writeFile(join(root, 'project.json'), `${JSON.stringify(manifest)}\n`)

  const result = await loadProjectDirectory(root)

  assert.equal(result.ok, true)
  const loaded = result.value.modules.flatMap(
    ({ type_declarations: values = [] }) => values,
  )
  assert.deepEqual(
    loaded.map(({ name }) => name),
    ['agent.demo.core.currency', 'agent.demo.api.currency'],
  )
  assert.deepEqual(
    loaded.map(({ declaration_digest }) => declaration_digest),
    declarations.map(typeDeclarationDigest),
  )
  assert.notEqual(loaded[0].declaration_digest, loaded[1].declaration_digest)

  const registry = loaded.map(({ declaration }) => declaration)
  const coreType = declaredType(loaded[0].declaration_digest)
  const apiType = declaredType(loaded[1].declaration_digest)
  assert.deepEqual(canonicalizeValue(coreType, { variant: 'usd' }, registry), {
    ok: true,
    value: { variant: 'usd' },
  })
  assert.deepEqual(canonicalizeValue(apiType, { variant: 'brl' }, registry), {
    ok: true,
    value: { variant: 'brl' },
  })
  assert.equal(
    canonicalizeValue(coreType, { variant: 'brl' }, registry)
      .diagnostics[0].code,
    'unknown-sum-variant',
  )
  assert.equal(
    canonicalizeValue(apiType, { variant: 'usd' }, registry)
      .diagnostics[0].code,
    'unknown-sum-variant',
  )
})

test('project loader rejects legacy review evidence as a second semantic authority', async () => {
  const root = await createProject()
  const manifest = JSON.parse(await readFile(join(root, 'project.json')))
  manifest.review_evidence = 'review-evidence.json'
  await writeFile(join(root, 'project.json'), `${JSON.stringify(manifest)}\n`)
  await writeFile(join(root, 'review-evidence.json'), '{}\n')

  const result = await loadProjectDirectory(root)

  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(
    ({ code, field }) =>
      code === 'unexpected-project-manifest-field' && field === 'review_evidence',
  ))
})

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), 're-project-loader-'))
  await mkdir(join(root, 'modules'))
  const coreSource = [
    're 1.0 compact',
    'module agent.demo.core',
    'export normalize',
    '',
  ].join('\n')
  const apiSource = [
    're 1.0 compact',
    'module agent.demo.api',
    'import agent.demo.core@INTERFACE_DIGEST as core',
    'export serve',
    '',
  ].join('\n')
  const coreInterface = {
    dependencies: [],
    exports: [{ contract_digest: digest('a'), kind: 'function', name: 'normalize' }],
    module: 'agent.demo.core',
    schema: 're.module-interface@0.1.0',
  }
  const apiInterface = {
    dependencies: [],
    exports: [{ contract_digest: digest('b'), kind: 'function', name: 'serve' }],
    module: 'agent.demo.api',
    schema: 're.module-interface@0.1.0',
  }
  apiInterface.dependencies.push({
    binding: 'core',
    interface_digest: moduleInterfaceDigest(coreInterface),
    module: 'agent.demo.core',
    scope: 'package',
  })
  const resolvedApiSource = apiSource.replace(
    'INTERFACE_DIGEST',
    moduleInterfaceDigest(coreInterface),
  )
  const packageManifest = {
    external_interfaces: [],
    modules: [
      {
        implementation_digest: sourceDigest(coreSource),
        interface: coreInterface,
        interface_digest: moduleInterfaceDigest(coreInterface),
        name: coreInterface.module,
      },
      {
        implementation_digest: sourceDigest(resolvedApiSource),
        interface: apiInterface,
        interface_digest: moduleInterfaceDigest(apiInterface),
        name: apiInterface.module,
      },
    ],
    package: 'agent.demo',
    schema: 're.package-manifest@0.1.0',
  }
  const projectManifest = {
    modules: [
      { name: coreInterface.module, path: 'modules/core.re', source_sha256: sourceDigest(coreSource) },
      { name: apiInterface.module, path: 'modules/api.re', source_sha256: sourceDigest(resolvedApiSource) },
    ],
    package_manifest: packageManifest,
    schema: 're.project-manifest@0.1.0',
  }
  await writeFile(join(root, 'modules/core.re'), coreSource)
  await writeFile(join(root, 'modules/api.re'), resolvedApiSource)
  await writeFile(join(root, 'project.json'), `${JSON.stringify(projectManifest)}\n`)
  return root
}

function digest(character) {
  return `sha256:${character.repeat(64)}`
}

function uid(character) {
  return `${character.repeat(25)}e`
}

function sourceDigest(source) {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`
}

function currencyDeclaration(module, variants) {
  return {
    body: {
      kind: 'sum',
      variants: variants.map((name) => ({ name })),
    },
    module,
    name: 'currency',
    parameters: [],
    schema: 're.type-declaration@0.1.0',
  }
}

function declaredType(declarationDigest) {
  return {
    arguments: [],
    declaration_digest: declarationDigest,
    kind: 'declared',
  }
}
