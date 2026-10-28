import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { agentAdapterContractDigest } from '../host/agent-adapter-contract.js'
import { businessFunctionDigest, validateBusinessFunction } from './business-function.js'
import { buildFactLedger } from './fact-ledger.js'
import { moduleInterfaceDigest } from './module-contract.js'
import {
  typeDeclarationDigest,
  validateTypeDeclaration,
  validateTypeReference,
} from './type-contract.js'

export const INTERFACE_PROJECTION_SCHEMA = 're.interface-projection@0.1.0'
export const INTERFACE_PROJECTION_MANIFEST_SCHEMA =
  're.interface-projection-manifest@0.1.0'
export const INTERFACE_PROJECTION_ROUTES_SCHEMA =
  're.interface-projection-routes@0.1.0'
export const INTERFACE_PROJECTION_RESULT_SCHEMA =
  're.interface-projection-result@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const MODULE_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u
const OPERATION_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u
const HTTP_METHODS = new Set(['DELETE', 'GET', 'PATCH', 'POST', 'PUT'])
const AUTH_MODES = new Set(['none', 'bearer'])
const IDEMPOTENCY_MODES = new Set(['none', 'optional', 'required'])
const ROUTE_FIELDS = [
  'auth',
  'error_variants',
  'idempotency',
  'method',
  'operation',
  'path',
  'success_status',
  'adapter',
]
const PRIMITIVE_TS = {
  bool: 'boolean',
  bytes: 'string',
  int: 'string',
  text: 'string',
  'text.utf8': 'string',
  unit: 'void',
}

let writeSequence = 0

export function buildInterfaceProjection(project, options = {}) {
  try {
    const routes = normalizeRoutes(options.routes)
    const graphRevision = requireDigest(project?.graph_revision, 'projection-invalid-graph-revision')
    if (options.graph_revision !== undefined
      && options.graph_revision !== graphRevision) {
      fail('projection-graph-revision-mismatch')
    }
    const modules = validateProjectModules(project)
    const ledger = buildFactLedger(project)
    if (!ledger.ok) fail(ledger.diagnostics[0].code)
    const allTypes = collectTypes(modules)
    const operations = []
    const usedRoutes = new Set()
    for (const route of routes) {
      if (usedRoutes.has(route.operation)) fail('duplicate-projection-operation', {
        operation: route.operation,
      })
      usedRoutes.add(route.operation)
      const operation = resolveOperation(
        modules,
        allTypes,
        ledger.value,
        route,
        graphRevision,
      )
      operations.push(operation)
    }
    if (operations.length === 0) fail('projection-route-set-empty')

    const types = [...allTypes.values()]
      .filter(({ used }) => used)
      .map(({ declaration, declaration_digest: declarationDigest, name }) => ({
        declaration: structuredClone(declaration),
        declaration_digest: declarationDigest,
        name,
      }))
      .sort((left, right) => compareText(left.name, right.name))
    const typeNames = typeNameMap(types)
    operations.sort((left, right) =>
      compareText(left.operation.name, right.operation.name))
    validateClientMethodNames(operations)
    const typeSource = renderTypes(types, typeNames)
    const clientSource = renderClient(operations, typeNames, types)
    const contract = {
      authority: {
        graph_revision: graphRevision,
        package_digest: requireDigest(
          project.package_digest,
          'projection-invalid-package-digest',
        ),
        project_digest: requireDigest(
          project.project_digest,
          'projection-invalid-project-digest',
        ),
      },
      operations,
      schema: INTERFACE_PROJECTION_SCHEMA,
      types,
    }
    const files = [
      { path: 'client.ts', sha256: digestText(clientSource) },
      { path: 'types.ts', sha256: digestText(typeSource) },
    ]
    const manifestWithoutDigest = {
      contract,
      files,
      schema: INTERFACE_PROJECTION_MANIFEST_SCHEMA,
    }
    const manifest = {
      ...manifestWithoutDigest,
      projection_digest: digest(manifestWithoutDigest),
    }
    const manifestSource = canonicalJson(manifest)
    const outputFiles = {
      'client.ts': clientSource,
      'projection.json': manifestSource,
      'types.ts': typeSource,
    }
    return {
      ok: true,
      value: {
        contract,
        files: outputFiles,
        manifest,
      },
    }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'invalid-interface-projection' }],
      ok: false,
    }
  }
}

export function validateInterfaceProjectionRoutes(input) {
  try {
    if (input?.schema !== INTERFACE_PROJECTION_ROUTES_SCHEMA
      || !Array.isArray(input.routes)
      || input.graph_revision === undefined) {
      fail('invalid-projection-routes')
    }
    const fields = Object.keys(input).sort(compareText)
    if (fields.join(',') !== 'graph_revision,routes,schema') {
      fail('unexpected-projection-routes-field', {
        field: fields.find((field) => !['graph_revision', 'routes', 'schema'].includes(field)),
      })
    }
    const graphRevision = requireDigest(
      input.graph_revision,
      'projection-invalid-graph-revision',
    )
    return {
      ok: true,
      value: {
        graph_revision: graphRevision,
        routes: normalizeRoutes(input.routes),
        schema: INTERFACE_PROJECTION_ROUTES_SCHEMA,
      },
    }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'invalid-projection-routes' }],
      ok: false,
    }
  }
}

export async function writeInterfaceProjection(project, options = {}) {
  const built = buildInterfaceProjection(project, options)
  if (!built.ok) return { ...built, written: false }
  const output = options.output
  if (typeof output !== 'string' || output.length === 0) {
    return {
      diagnostics: [{ code: 'projection-output-required' }],
      ok: false,
      written: false,
    }
  }
  let temporary
  let backup
  try {
    await mkdir(dirname(output), { recursive: true })
    const existing = await existingOutputKind(output)
    if (existing === 'symlink') fail('projection-output-symlink')
    if (existing === 'file') fail('projection-output-not-directory')
    temporary = await mkdtemp(join(dirname(output), '.re-interface-projection-'))
    for (const [path, content] of Object.entries(built.value.files)) {
      await writeFile(join(temporary, path), content, 'utf8')
    }
    if (existing === 'directory') {
      backup = `${output}.previous-${process.pid}-${writeSequence++}`
      await rename(output, backup)
    }
    await rename(temporary, output)
    temporary = null
    if (backup !== undefined) await rm(backup, { force: true, recursive: true })
    return { ...built, written: true }
  } catch (error) {
    if (temporary !== null && temporary !== undefined) {
      await rm(temporary, { force: true, recursive: true }).catch(() => {})
    }
    if (backup !== undefined) {
      await rm(output, { force: true, recursive: true }).catch(() => {})
      await rename(backup, output).catch(() => {})
    }
    return {
      diagnostics: [error?.diagnostic ?? {
        code: 'projection-write-failed',
        reason: error?.code ?? 'unknown',
      }],
      ok: false,
      written: false,
    }
  }
}

export async function verifyInterfaceProjection(project, options = {}) {
  const built = buildInterfaceProjection(project, options)
  if (!built.ok) return built
  const output = options.output
  if (typeof output !== 'string' || output.length === 0) {
    return {
      diagnostics: [{ code: 'projection-output-required' }],
      ok: false,
    }
  }
  try {
    const directory = await lstat(output)
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      return {
        diagnostics: [{ code: 'projection-output-not-directory' }],
        ok: false,
      }
    }
    const names = await readdir(output)
    const expectedNames = Object.keys(built.value.files).sort(compareText)
    if (names.length !== expectedNames.length
      || names.some((name, index) => name !== expectedNames[index])) {
      return {
        diagnostics: [{ code: 'projection-artifact-file-set-drift' }],
        ok: false,
      }
    }
    const actual = {}
    for (const path of Object.keys(built.value.files)) {
      const file = await lstat(join(output, path))
      if (!file.isFile() || file.isSymbolicLink()) {
        return {
          diagnostics: [{ code: 'projection-artifact-not-regular-file', path }],
          ok: false,
        }
      }
      actual[path] = await readFile(join(output, path), 'utf8')
    }
    for (const [path, expected] of Object.entries(built.value.files)) {
      if (actual[path] !== expected) {
        return {
          diagnostics: [{ code: 'projection-artifact-drift', path }],
          ok: false,
        }
      }
    }
    const actualManifest = JSON.parse(actual['projection.json'])
    if (canonicalJson(actualManifest) !== actual['projection.json']
      || !same(actualManifest, built.value.manifest)
      || actualManifest.projection_digest !== built.value.manifest.projection_digest) {
      return {
        diagnostics: [{ code: 'projection-manifest-drift' }],
        ok: false,
      }
    }
    return { ok: true, value: built.value.manifest }
  } catch (error) {
    return {
      diagnostics: [{
        code: error?.code === 'ENOENT'
          ? 'projection-artifact-missing'
          : 'projection-artifact-unreadable',
      }],
      ok: false,
    }
  }
}

function resolveOperation(modules, types, ledger, route, graphRevision) {
  if (!OPERATION_NAME.test(route.operation)) fail('invalid-projection-operation')
  const separator = route.operation.lastIndexOf('.')
  const moduleName = separator < 0 ? '' : route.operation.slice(0, separator)
  const localName = route.operation.slice(separator + 1)
  const module = modules.find(({ name }) => name === moduleName)
  if (module === undefined) fail('projection-operation-module-not-found', {
    operation: route.operation,
  })
  const moduleInterface = interfaceOf(module)
  const exported = moduleInterface.exports.find(
    ({ kind, name }) => kind === 'function' && name === localName,
  )
  if (exported === undefined) fail('projection-operation-not-exported', {
    operation: route.operation,
  })
  const functionEntry = module.function_declarations?.find(
    ({ name }) => name === route.operation,
  )
  if (functionEntry === undefined) fail('projection-operation-authority-missing', {
    operation: route.operation,
  })
  const declaration = checkedFunctionDeclaration(functionEntry)
  const functionDigest = functionEntry.declaration_digest
  if (exported.contract_digest !== functionDigest) {
    fail('projection-operation-contract-mismatch', { operation: route.operation })
  }
  markType(types, declaration.input_type)
  markType(types, declaration.output_type)
  markType(types, declaration.error_type)
  const adapter = resolveAdapter(module, route.adapter, declaration, types)
  const errorDeclaration = resolveDeclaredType(types, declaration.error_type)
  const errorVariants = errorVariantsOf(errorDeclaration, adapter.error_variants)
  if (!sameStrings(route.error_variants, errorVariants)) {
    fail('projection-error-variant-mismatch', { operation: route.operation })
  }
  const fact = ledger.facts.find(
    ({ kind, path }) =>
      kind === 'function-declaration'
      && path.join('/') === `project/module/${moduleName}/function/${route.operation}`,
  )
  if (fact === undefined) fail('projection-operation-fact-missing', {
    operation: route.operation,
  })
  return {
    authority: {
      capability: adapter.capability,
      adapter_contract_digest: agentAdapterContractDigest(adapter),
      fact: {
        fact_id: fact.fact_id,
        graph_revision: fact.graph_revision,
        uid_anchor: fact.uid_anchor,
      },
      interface_digest: module.interface_digest,
      module: module.name,
      operation: {
        contract_digest: functionDigest,
        declaration_digest: functionEntry.declaration_digest,
        name: route.operation,
      },
      resource: adapter.resource,
      revision: graphRevision,
      profile: adapter.profile,
    },
    error: {
      type: typeName(types, declaration.error_type),
      variants: errorVariants,
    },
    idempotency: route.idempotency,
    input: typeName(types, declaration.input_type),
    input_type: structuredClone(declaration.input_type),
    operation: {
      contract_digest: functionDigest,
      declaration_digest: functionEntry.declaration_digest,
      name: route.operation,
    },
    output: typeName(types, declaration.output_type),
    output_type: structuredClone(declaration.output_type),
    error_type: structuredClone(declaration.error_type),
    route: {
      auth: route.auth,
      method: route.method,
      path: route.path,
      success_status: route.success_status,
    },
  }
}

function resolveAdapter(module, adapterName, declaration, types) {
  if (typeof adapterName !== 'string') fail('projection-adapter-required')
  const entry = module.adapter_contracts?.find(({ name }) => name === adapterName)
  if (entry === undefined) fail('projection-adapter-not-found', { adapter: adapterName })
  if (entry.contract_digest !== agentAdapterContractDigest(entry.contract)) {
    fail('projection-adapter-contract-mismatch', { adapter: adapterName })
  }
  const call = declaration.body.capability_calls[0]
  if (declaration.body.capability_calls.length !== 1
    || entry.contract.module !== module.name
    || entry.contract.node_uid !== call.node_uid
    || !same(entry.contract.capability, call.capability)
    || !same(entry.contract.resource, call.resource)
    || !adapterTypeMatches(entry.contract.input_type, call.input_type, types)
    || !adapterTypeMatches(entry.contract.output_type, call.output_type, types)
    || !adapterTypeMatches(entry.contract.error_type, call.error_type, types)) {
    fail('projection-adapter-operation-mismatch', { adapter: adapterName })
  }
  return entry.contract
}

function adapterTypeMatches(named, declared, types) {
  if (named?.kind !== 'type' || typeof named.name !== 'string'
    || declared?.kind !== 'declared') {
    return false
  }
  const matches = [...types.values()].filter(({ name }) => name === named.name)
  return matches.length === 1
    && matches[0].declaration_digest === declared.declaration_digest
}

function collectTypes(modules) {
  const types = new Map()
  for (const module of modules) {
    for (const entry of module.type_declarations ?? []) {
      if (!MODULE_NAME.test(entry.name)
        || !DIGEST.test(entry.declaration_digest)
        || entry.declaration_digest !== typeDeclarationDigest(entry.declaration)) {
        fail('projection-type-declaration-mismatch', { name: entry.name })
      }
      const validation = validateTypeDeclaration(entry.declaration)
      if (!validation.ok) fail('projection-type-declaration-invalid', { name: entry.name })
      if (types.has(entry.declaration_digest)) {
        fail('projection-duplicate-type-declaration', { name: entry.name })
      }
      types.set(entry.declaration_digest, {
        declaration: structuredClone(entry.declaration),
        declaration_digest: entry.declaration_digest,
        name: entry.name,
        used: false,
      })
    }
  }
  return types
}

function markType(types, type, stack = new Set()) {
  if (type.kind === 'declared') {
    const entry = types.get(type.declaration_digest)
    if (entry === undefined) fail('projection-type-declaration-not-found', {
      declaration_digest: type.declaration_digest,
    })
    if (stack.has(type.declaration_digest)) {
      fail('projection-recursive-type-unsupported')
    }
    entry.used = true
    const next = new Set(stack).add(type.declaration_digest)
    markDeclarationBody(types, entry.declaration.body, next)
    return
  }
  if (type.kind === 'primitive' || type.kind === 'decimal') return
  if (type.kind === 'list' || type.kind === 'set') return markType(types, type.element, stack)
  if (type.kind === 'option') return markType(types, type.value, stack)
  if (type.kind === 'map') {
    markType(types, type.key, stack)
    return markType(types, type.value, stack)
  }
  if (type.kind === 'result') {
    markType(types, type.ok, stack)
    return markType(types, type.error, stack)
  }
  if (type.kind === 'self') fail('projection-recursive-type-unsupported')
  fail('projection-unsupported-type', { kind: type.kind })
}

function markDeclarationBody(types, body, stack) {
  if (body.kind === 'record') {
    for (const field of body.fields) markType(types, field.type, stack)
    return
  }
  if (body.kind === 'sum') {
    for (const variant of body.variants) {
      if (variant.type !== undefined) markType(types, variant.type, stack)
    }
    return
  }
  if (body.kind === 'newtype') {
    markType(types, body.type, stack)
    return
  }
  fail('projection-unsupported-type', { kind: body.kind })
}

function resolveDeclaredType(types, type) {
  if (type.kind !== 'declared') fail('projection-error-type-not-declared')
  const entry = types.get(type.declaration_digest)
  if (entry === undefined) fail('projection-type-declaration-not-found', {
    declaration_digest: type.declaration_digest,
  })
  return entry.declaration
}

function errorVariantsOf(entry, adapterVariants) {
  if (entry.body.kind === 'sum'
    && entry.body.variants.every(({ type }) => type === undefined)) {
    return entry.body.variants.map(({ name }) => name).sort(compareText)
  }
  if (entry.body.kind === 'record'
    && entry.body.fields.length === 2
    && entry.body.fields.every(({ name, type }) =>
      (name === 'type' || name === 'variant')
      && type.kind === 'primitive'
      && type.name === 'text.utf8')
    && new Set(entry.body.fields.map(({ name }) => name)).size === 2) {
    return [...adapterVariants].sort(compareText)
  }
  fail('projection-error-type-unsupported')
}

function checkedFunctionDeclaration(entry) {
  const validation = validateBusinessFunction(entry.declaration)
  if (validation.ok) {
    if (entry.declaration_digest !== businessFunctionDigest(entry.declaration)) {
      fail('projection-operation-contract-mismatch')
    }
    return validation.value
  }
  const declaration = entry?.declaration
  if (declaration === null || typeof declaration !== 'object'
    || Array.isArray(declaration)
    || declaration.schema !== 're.function-declaration@0.1.0'
    || declaration.body === null
    || typeof declaration.body !== 'object'
    || Array.isArray(declaration.body)
    || declaration.body.control_flow?.schema !== 're.control-flow-graph@0.1.0'
    || !Array.isArray(declaration.body.calls)
    || !Array.isArray(declaration.body.capability_calls)
    || !Array.isArray(declaration.body.effect_edges)) {
    fail('projection-operation-declaration-invalid')
  }
  for (const type of [
    declaration.input_type,
    declaration.output_type,
    declaration.error_type,
  ]) {
    if (!validateTypeReference(type).ok) {
      fail('projection-operation-declaration-invalid')
    }
  }
  if (entry.declaration_digest !== checkedFunctionDigest(declaration)) {
    fail('projection-operation-contract-mismatch')
  }
  if (!Array.isArray(declaration.body.control_flow.edges)
    || !Array.isArray(declaration.body.control_flow.nodes)
    || !Object.hasOwn(declaration.body.control_flow, 'construct')
    || !Object.hasOwn(declaration.body.control_flow, 'output')) {
    fail('projection-operation-declaration-invalid')
  }
  return structuredClone(declaration)
}

function typeNameMap(types) {
  const names = new Map()
  const used = new Map()
  for (const entry of types) {
    const name = tsTypeName(entry.name)
    const previous = used.get(name)
    if (previous !== undefined && previous !== entry.declaration_digest) {
      fail('projection-type-name-collision', { name })
    }
    used.set(name, entry.declaration_digest)
    names.set(entry.declaration_digest, name)
  }
  return names
}

function renderTypes(types, names) {
  const lines = [
    '// Generated by Revia interface projection.',
    '// Contract authority is recorded in projection.json.',
    '',
  ]
  for (const entry of types) {
    const name = names.get(entry.declaration_digest)
    lines.push(renderTypeDeclaration(entry.declaration, name, names))
    lines.push('')
  }
  return `${lines.join('\n')}`
}

function renderTypeDeclaration(declaration, name, names) {
  const body = declaration.body
  if (body.kind === 'newtype') {
    return `export type ${name} = ${renderType(body.type, names)}`
  }
  if (body.kind === 'record') {
    return [
      `export interface ${name} {`,
      ...body.fields.map(({ name: field, type }) =>
        `  ${field}: ${renderType(type, names)};`),
      '}',
    ].join('\n')
  }
  return [
    `export type ${name} =`,
    ...body.variants.map(({ name: variant, type }) =>
      type === undefined
        ? `  | { readonly variant: '${variant}' }`
        : `  | { readonly variant: '${variant}'; value: ${renderType(type, names)} }`),
    ''
  ].join('\n').trimEnd()
}

function renderType(type, names) {
  if (type.kind === 'primitive') return PRIMITIVE_TS[type.name] ?? fail('projection-unsupported-type')
  if (type.kind === 'decimal') return 'string'
  if (type.kind === 'declared') {
    const name = names.get(type.declaration_digest)
    if (name === undefined) fail('projection-type-declaration-not-found')
    return name
  }
  if (type.kind === 'list') return `ReadonlyArray<${renderType(type.element, names)}>`
  if (type.kind === 'set') return `ReadonlyArray<${renderType(type.element, names)}>`
  if (type.kind === 'option') {
    return `{ readonly variant: 'none' } | { readonly variant: 'some'; value: ${renderType(type.value, names)} }`
  }
  if (type.kind === 'map') {
    return `ReadonlyArray<{ key: ${renderType(type.key, names)}; value: ${renderType(type.value, names)} }>`
  }
  if (type.kind === 'result') {
    return `{ readonly kind: 'ok'; value: ${renderType(type.ok, names)} } | { readonly kind: 'err'; error: ${renderType(type.error, names)} }`
  }
  fail('projection-unsupported-type', { kind: type.kind })
}

function renderClient(operations, names, types) {
  const lines = [
    '// Generated by Revia interface projection.',
    "import type { " + [...names.values()].sort(compareText).join(', ') + " } from './types.js'",
    '',
    'export interface ProjectionTransport {',
    '  request(request: { method: string; url: string; body: string | null; headers: string }): Promise<{ status: number; body: string }>',
    '}',
    '',
    'const INVALID_HEADER_VALUE = /[\\u0000-\\u0008\\u000a-\\u001f\\u007f]/u',
    '',
    'function assertHeaderValue(value: string): string {',
    "  if (typeof value !== 'string' || INVALID_HEADER_VALUE.test(value) || hasUnpairedSurrogate(value)) throw new Error('invalid-header-value')",
    '  return value',
    '}',
    '',
    'function hasUnpairedSurrogate(value: string): boolean {',
    '  for (let index = 0; index < value.length; index += 1) {',
    '    const code = value.charCodeAt(index)',
    '    if (code >= 0xd800 && code <= 0xdbff) {',
    '      if (index + 1 >= value.length) return true',
    '      const next = value.charCodeAt(index + 1)',
    '      if (next < 0xdc00 || next > 0xdfff) return true',
    '      index += 1',
    '    } else if (code >= 0xdc00 && code <= 0xdfff) {',
    '      return true',
    '    }',
    '  }',
    '  return false',
    '}',
    '',
    'function isRecord(value: unknown): value is Record<string, unknown> {',
    '  return value !== null && typeof value === \'object\' && !Array.isArray(value)',
    '}',
    '',
    'function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {',
    '  const actual = Object.keys(value)',
    '  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))',
    '}',
    '',
    'function isText(value: unknown): value is string {',
    '  return typeof value === \'string\' && !hasUnpairedSurrogate(value)',
    '}',
    '',
    'function isJsonInt(value: unknown): value is string {',
    '  return typeof value === \'string\' && /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u.test(value)',
    '}',
    '',
    'function isJsonBytes(value: unknown): value is string {',
    '  return typeof value === \'string\' && /^hex:(?:[0-9a-f]{2})*$/u.test(value)',
    '}',
    '',
    'function isJsonDecimal(value: unknown, scale: number): value is string {',
    '  if (typeof value !== \'string\' || !Number.isInteger(scale) || scale < 0 || scale > 255) return false',
    '  if (scale === 0) return /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u.test(value)',
    '  return new RegExp(`^-?(?:0|[1-9][0-9]*)\\\\.[0-9]{${scale}}$`, \'u\').test(value) && !value.startsWith(\'-0.\')',
    '}',
    '',
    'function decodeJson<T>(body: string, guard: (value: unknown) => value is T): T {',
    '  let value: unknown',
    '  try {',
    '    value = JSON.parse(body)',
    '  } catch {',
    "    throw new Error('response-contract-mismatch')",
    '  }',
    '  if (!guard(value)) throw new Error(\'response-contract-mismatch\')',
    '  return value',
    '}',
    '',
    ...types.flatMap(({ declaration, declaration_digest: declarationDigest }) => [
      renderTypeGuard(
        declaration,
        names.get(declarationDigest),
        names,
      ),
      '',
    ]),
    ...operations.flatMap((entry) => {
      const methodName = entry.operation.name.slice(entry.operation.name.lastIndexOf('.') + 1)
      return [
        `function is${capitalize(methodName)}Output(value: unknown): value is ${entry.output} {`,
        `  return ${renderGuardExpression(entry.output_type, 'value', names)}`,
        '}',
        '',
        `function is${capitalize(methodName)}Error(value: unknown): value is ${entry.error.type} {`,
        `  return ${renderGuardExpression(entry.error_type, 'value', names)}`,
        '}',
        '',
      ]
    }),
    'export class ProjectionClient {',
    '  constructor(private readonly transport: ProjectionTransport, private readonly baseUrl: string) {}',
  ]
  for (const entry of operations) {
    const methodName = entry.operation.name.slice(entry.operation.name.lastIndexOf('.') + 1)
    lines.push(
      `  async ${methodName}(input: ${entry.input}, options: { token?: string; idempotencyKey?: string } = {}): Promise<{ kind: 'ok'; value: ${entry.output} } | { kind: 'err'; error: ${entry.error.type} }> {`,
      "    const headers = ['content-type:application/json', 'x-revia-graph-revision:" + entry.authority.revision + "', 'x-revia-interface-digest:" + entry.authority.interface_digest + "', 'x-revia-profile:" + entry.authority.profile.id + "']",
      ...(entry.route.auth.mode === 'bearer' ? [
        "    if (options.token === undefined) throw new Error('auth-token-required')",
        "    headers.push('authorization:Bearer ' + assertHeaderValue(options.token))",
      ] : []),
      ...(entry.idempotency.mode === 'required' ? [
        "    if (options.idempotencyKey === undefined) throw new Error('idempotency-key-required')",
        "    headers.push('idempotency-key:' + assertHeaderValue(options.idempotencyKey))",
      ] : []),
      ...(entry.idempotency.mode === 'optional' ? [
        "    if (options.idempotencyKey !== undefined) headers.push('idempotency-key:' + assertHeaderValue(options.idempotencyKey))",
      ] : []),
      '    headers.sort()',
      `    const response = await this.transport.request({ method: '${entry.route.method}', url: this.baseUrl + '${entry.route.path}', body: JSON.stringify(input), headers: headers.join('\\n') })`,
      '    if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599 || typeof response.body !== \'string\') throw new Error(\'invalid-response\')',
      `    if (response.status === ${entry.route.success_status}) return { kind: 'ok', value: decodeJson(response.body, is${capitalize(methodName)}Output) }`,
      `    return { kind: 'err', error: decodeJson(response.body, is${capitalize(methodName)}Error) }`,
      '  }',
    )
  }
  lines.push('}', '')
  return lines.join('\n')
}

function renderTypeGuard(declaration, name, names) {
  return [
    `function is${name}(value: unknown): value is ${name} {`,
    `  return ${renderGuardDeclarationExpression(declaration.body, 'value', names)}`,
    '}',
  ].join('\n')
}

function renderGuardDeclarationExpression(body, value, names) {
  if (body.kind === 'newtype') {
    return renderGuardExpression(body.type, value, names)
  }
  if (body.kind === 'record') {
    const keys = `[${body.fields.map(({ name }) => JSON.stringify(name)).join(', ')}]`
    const fields = body.fields.map(({ name, type }) =>
      renderGuardExpression(type, `${value}[${JSON.stringify(name)}]`, names))
    return [
      `isRecord(${value})`,
      `hasOnlyKeys(${value}, ${keys})`,
      ...fields,
    ].join(' && ')
  }
  if (body.kind === 'sum') {
    const variants = body.variants.map(({ name, type }) => {
      const keys = type === undefined
        ? `['variant']`
        : `['variant', 'value']`
      const checks = [
        `isRecord(${value})`,
        `hasOnlyKeys(${value}, ${keys})`,
        `${value}.variant === ${JSON.stringify(name)}`,
      ]
      if (type !== undefined) {
        checks.push(renderGuardExpression(type, `${value}.value`, names))
      }
      return `(${checks.join(' && ')})`
    })
    return variants.join(' || ')
  }
  fail('projection-unsupported-type', { kind: body.kind })
}

function renderGuardExpression(type, value, names) {
  if (type.kind === 'primitive') {
    if (type.name === 'unit') return `${value} === null`
    if (type.name === 'bool') return `typeof ${value} === 'boolean'`
    if (type.name === 'int') return `isJsonInt(${value})`
    if (type.name === 'text.utf8') return `isText(${value})`
    if (type.name === 'bytes') return `isJsonBytes(${value})`
    fail('projection-unsupported-type', { kind: type.name })
  }
  if (type.kind === 'decimal') {
    return `isJsonDecimal(${value}, ${type.scale})`
  }
  if (type.kind === 'declared') {
    const name = names.get(type.declaration_digest)
    if (name === undefined) fail('projection-type-declaration-not-found')
    return `is${name}(${value})`
  }
  if (type.kind === 'list' || type.kind === 'set') {
    return `Array.isArray(${value}) && ${value}.every((entry) => ${renderGuardExpression(type.element, 'entry', names)})`
  }
  if (type.kind === 'option') {
    return [
      `isRecord(${value})`,
      `((hasOnlyKeys(${value}, ['variant']) && ${value}.variant === 'none')`,
      `|| (hasOnlyKeys(${value}, ['variant', 'value']) && ${value}.variant === 'some' && ${renderGuardExpression(type.value, `${value}.value`, names)}))`,
    ].join(' && ')
  }
  if (type.kind === 'map') {
    return `Array.isArray(${value}) && ${value}.every((entry) => isRecord(entry) && hasOnlyKeys(entry, ['key', 'value']) && ${renderGuardExpression(type.key, 'entry.key', names)} && ${renderGuardExpression(type.value, 'entry.value', names)})`
  }
  if (type.kind === 'result') {
    return [
      `isRecord(${value})`,
      `((hasOnlyKeys(${value}, ['kind', 'value']) && ${value}.kind === 'ok' && ${renderGuardExpression(type.ok, `${value}.value`, names)})`,
      `|| (hasOnlyKeys(${value}, ['kind', 'error']) && ${value}.kind === 'err' && ${renderGuardExpression(type.error, `${value}.error`, names)}))`,
    ].join(' && ')
  }
  fail('projection-unsupported-type', { kind: type.kind })
}

function capitalize(value) {
  return value[0].toUpperCase() + value.slice(1)
}

function validateClientMethodNames(operations) {
  const names = new Map()
  for (const entry of operations) {
    const name = entry.operation.name.slice(entry.operation.name.lastIndexOf('.') + 1)
    const previous = names.get(name)
    if (previous !== undefined && previous !== entry.operation.name) {
      fail('projection-client-method-name-collision', {
        method: name,
        operations: [previous, entry.operation.name],
      })
    }
    names.set(name, entry.operation.name)
  }
}

function normalizeRoutes(routes) {
  if (!Array.isArray(routes)) fail('projection-routes-required')
  return routes.map((route) => {
    if (route === null || typeof route !== 'object' || Array.isArray(route)) {
      fail('invalid-projection-route')
    }
    const unknown = Object.keys(route).find((field) => !ROUTE_FIELDS.includes(field))
    if (unknown !== undefined) fail('unexpected-projection-route-field', { field: unknown })
    if (!HTTP_METHODS.has(route.method)
      || typeof route.path !== 'string'
      || !route.path.startsWith('/')
      || route.path.includes('?')
      || route.path.includes('#')
      || (route.path !== '/'
        && route.path.split('/').slice(1).some((segment) => segment === '..' || segment === ''))
      || !Number.isSafeInteger(route.success_status)
      || route.success_status < 200
      || route.success_status > 599) {
      fail('invalid-projection-route')
    }
    if (!route.auth || !AUTH_MODES.has(route.auth.mode)
      || Object.keys(route.auth).length !== 1) {
      fail('invalid-projection-route-auth')
    }
    if (!route.idempotency || !IDEMPOTENCY_MODES.has(route.idempotency.mode)
      || Object.keys(route.idempotency).length !== 1) {
      fail('invalid-projection-route-idempotency')
    }
    if (!Array.isArray(route.error_variants)
      || route.error_variants.some((value) => typeof value !== 'string')) {
      fail('invalid-projection-route-errors')
    }
    return {
      adapter: route.adapter,
      auth: { mode: route.auth.mode },
      error_variants: [...route.error_variants].sort(compareText),
      idempotency: { mode: route.idempotency.mode },
      method: route.method,
      operation: route.operation,
      path: route.path,
      success_status: route.success_status,
    }
  })
}

function validateProjectModules(project) {
  if (project?.schema !== 're.project-graph@0.1.0'
    || !Array.isArray(project.modules)
    || project.modules.length === 0) {
    fail('projection-invalid-project')
  }
  for (const module of project.modules) {
    if (!MODULE_NAME.test(module.name)
      || !DIGEST.test(module.interface_digest)
      || module.interface_digest !== moduleInterfaceDigest(interfaceOf(module))) {
      fail('projection-module-interface-mismatch', { module: module.name })
    }
  }
  return project.modules
}

function typeName(types, type) {
  if (type.kind !== 'declared') return renderType(type, new Map())
  const entry = types.get(type.declaration_digest)
  if (entry === undefined) fail('projection-type-declaration-not-found', {
    declaration_digest: type.declaration_digest,
  })
  return tsTypeName(entry.name)
}

function interfaceOf(module) {
  const value = module?.interface ?? module?.surface?.interface
  if (value === undefined) fail('projection-module-interface-missing', {
    module: module?.name,
  })
  return value
}

function tsTypeName(qualifiedName) {
  return qualifiedName
    .slice(qualifiedName.lastIndexOf('.') + 1)
    .split('_')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')
}

function checkedFunctionDigest(declaration) {
  const body = declaration.body
  const controlFlow = body.control_flow
  const edges = Array.isArray(controlFlow.edges)
    ? [...controlFlow.edges]
      .sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)))
      .map((edge) => structuredClone(edge))
    : controlFlow.edges
  const nodes = Array.isArray(controlFlow.nodes)
    ? [...controlFlow.nodes]
      .sort((left, right) => compareText(left.id, right.id))
      .map((node) => structuredClone(node))
    : controlFlow.nodes
  const normalized = {
    body: {
      calls: [...body.calls].sort(compareText),
      capability_calls: [...body.capability_calls]
        .sort((left, right) => compareText(left.id, right.id))
        .map((call) => ({
          capability: structuredClone(call.capability),
          error_type: structuredClone(call.error_type),
          id: call.id,
          input_type: structuredClone(call.input_type),
          node_uid: call.node_uid,
          output_type: structuredClone(call.output_type),
          resource: structuredClone(call.resource),
        })),
      control_flow: {
        construct: controlFlow.construct,
        edges,
        nodes,
        output: controlFlow.output,
        schema: controlFlow.schema,
      },
      effect_edges: [...body.effect_edges]
        .sort((left, right) => compareText(left.call, right.call))
        .map((edge) => structuredClone(edge)),
    },
    error_type: structuredClone(declaration.error_type),
    input_type: structuredClone(declaration.input_type),
    module: declaration.module,
    name: declaration.name,
    output_type: structuredClone(declaration.output_type),
    schema: 're.function-declaration@0.1.0',
  }
  return stableDigest(normalized)
}

function stableDigest(value) {
  return `sha256:${createHash('sha256').update(stableJson(value), 'utf8').digest('hex')}`
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function requireDigest(value, code) {
  if (!DIGEST.test(value)) fail(code)
  return value
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

function digestText(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function canonicalJson(value) {
  return `${JSON.stringify(canonical(value))}\n`
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort(compareText).map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
}

function compareText(left, right) {
  return Buffer.from(String(left), 'utf8').compare(Buffer.from(String(right), 'utf8'))
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}

async function existingOutputKind(path) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return 'symlink'
    if (info.isDirectory()) return 'directory'
    return 'file'
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing'
    throw error
  }
}
