import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const REACT_CLIENT_PROJECTION_SCHEMA = 're.react-client-projection@0.1.0'
export const REACT_CLIENT_PROJECTION_MANIFEST_SCHEMA = 're.react-client-projection-manifest@0.1.0'
const CONTRACT_SCHEMA = 're.interface-projection-manifest@0.1.0'
const CONTRACT_FILE = 'projection.json'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const OPERATION_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u
const METHOD_NAME = /^[a-z][a-z0-9_]*$/u
const PRIMITIVE_TEXT = new Set(['bytes', 'text', 'text.utf8'])

let writeSequence = 0

/**
 * Build a React client projection from a checked interface projection manifest.
 *
 * The interface projection is the authority for operations, wire types and
 * route facts. This module adds a hook per operation plus a form/outcome panel
 * per operation, and emits one manifest that binds every emitted file back to
 * the `projection_digest` it was generated from.
 */
export function buildReactClientProjection(manifest, options = {}) {
  try {
    if (manifest?.schema !== CONTRACT_SCHEMA) fail('react-projection-contract-invalid')
    const operations = manifest?.contract?.operations
    if (!Array.isArray(operations) || operations.length === 0) {
      fail('react-projection-route-set-empty')
    }
    const types = manifest?.contract?.types
    if (!Array.isArray(types) || types.length === 0) fail('react-projection-type-set-empty')
    const projectionDigest = requireDigest(
      manifest.projection_digest,
      'react-projection-contract-digest-invalid',
    )
    const recomputed = digest({
      contract: manifest.contract,
      files: manifest.files,
      schema: manifest.schema,
    })
    if (recomputed !== projectionDigest) fail('react-projection-contract-digest-mismatch')
    const graphRevision = requireDigest(
      manifest?.contract?.authority?.graph_revision,
      'react-projection-graph-revision-invalid',
    )
    if (options.graph_revision !== undefined && options.graph_revision !== graphRevision) {
      fail('react-projection-graph-revision-mismatch')
    }

    const declarations = new Map(types.map((entry) => [entry.declaration_digest, entry]))
    const names = typeNameMap(types)
    const rendered = []
    const seen = new Set()
    for (const operation of [...operations].sort((left, right) =>
      compareText(left.operation.name, right.operation.name))) {
      const name = operation?.operation?.name
      if (typeof name !== 'string' || !OPERATION_NAME.test(name)) {
        fail('react-projection-contract-invalid')
      }
      const methodName = name.slice(name.lastIndexOf('.') + 1)
      if (!METHOD_NAME.test(methodName) || seen.has(methodName)) {
        fail('react-projection-operation-name-collision', { operation: name })
      }
      seen.add(methodName)
      const inputName = resolveDeclaredName(operation.input_type, names, declarations, 'input')
      const outputName = resolveDeclaredName(operation.output_type, names, declarations, 'output')
      const errorName = resolveDeclaredName(operation.error_type, names, declarations, 'error')
      const inputDeclaration = declarations.get(operation.input_type.declaration_digest)
      if (inputDeclaration?.declaration?.body?.kind !== 'record') {
        fail('react-projection-unsupported-input', { operation: name })
      }
      const fields = inputDeclaration.declaration.body.fields.map((field) =>
        describeField(field, names, declarations, name))
      const resultFields = describeResultFields(
        declarations.get(operation.output_type.declaration_digest),
        names,
        declarations,
        name,
      )
      rendered.push({
        context: operation,
        errorName,
        fields,
        inputName,
        methodName,
        name,
        operation,
        outputName,
        resultFields,
      })
    }

    const operationsSource = renderOperations(rendered)
    const panelsSource = renderPanels(rendered)
    const files = [
      { path: 'operations.ts', sha256: digestText(operationsSource) },
      { path: 'panels.tsx', sha256: digestText(panelsSource) },
    ]

    const summary = rendered.map((entry) => ({
      error_type: entry.errorName,
      fields: entry.fields.map((field) => ({
        control: field.control,
        name: field.name,
        ...(field.control === 'select' ? { variants: field.variants } : {}),
        ...(field.control === 'decimal' ? { scale: field.scale } : {}),
      })),
      hook: `use${capitalize(entry.methodName)}`,
      input_type: entry.inputName,
      operation: entry.name,
      output_type: entry.outputName,
      panel: `${capitalize(entry.methodName)}Panel`,
      result_fields: entry.resultFields,
      route: {
        method: entry.operation.route.method,
        path: entry.operation.route.path,
        success_status: entry.operation.route.success_status,
      },
    }))
    const manifestWithoutDigest = {
      authority: {
        graph_revision: graphRevision,
        projection_digest: projectionDigest,
      },
      files,
      operations: summary,
      schema: REACT_CLIENT_PROJECTION_MANIFEST_SCHEMA,
    }
    const projectionManifest = {
      ...manifestWithoutDigest,
      react_digest: digest(manifestWithoutDigest),
    }
    const manifestSource = canonicalJson(projectionManifest)
    return {
      ok: true,
      value: {
        files: {
          'operations.ts': operationsSource,
          'panels.tsx': panelsSource,
          'react-client.json': manifestSource,
        },
        manifest: projectionManifest,
      },
    }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'invalid-react-client-projection' }],
      ok: false,
    }
  }
}

export function validateReactClientProjectionManifest(input) {
  try {
    if (input?.schema !== REACT_CLIENT_PROJECTION_MANIFEST_SCHEMA) {
      fail('react-projection-manifest-invalid')
    }
    requireDigest(input?.authority?.graph_revision, 'react-projection-graph-revision-invalid')
    requireDigest(input?.authority?.projection_digest, 'react-projection-contract-digest-invalid')
    requireDigest(input?.react_digest, 'react-projection-digest-invalid')
    const recomputed = digest({
      authority: input.authority,
      files: input.files,
      operations: input.operations,
      schema: input.schema,
    })
    if (recomputed !== input.react_digest) fail('react-projection-digest-mismatch')
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
      fail('react-projection-route-set-empty')
    }
    for (const file of input.files ?? []) {
      requireDigest(file?.sha256, 'react-projection-file-digest-invalid')
      if (file.path !== 'operations.ts' && file.path !== 'panels.tsx') {
        fail('react-projection-file-set-invalid', { path: String(file?.path) })
      }
    }
    return { ok: true, value: input }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'react-projection-manifest-invalid' }],
      ok: false,
    }
  }
}

export async function readReactClientContract(contractFile) {
  try {
    const source = await readFile(contractFile, 'utf8')
    return { ok: true, value: JSON.parse(source) }
  } catch (error) {
    return {
      diagnostics: [{
        code: error?.code === 'ENOENT'
          ? 'react-projection-contract-missing'
          : 'react-projection-contract-unreadable',
      }],
      ok: false,
    }
  }
}

export async function writeReactClientProjection(manifest, options = {}) {
  const built = buildReactClientProjection(manifest, options)
  if (!built.ok) return { ...built, written: false }
  const output = options.output
  if (typeof output !== 'string' || output.length === 0) {
    return { diagnostics: [{ code: 'projection-output-required' }], ok: false, written: false }
  }
  const names = Object.keys(built.value.files).sort(compareText)
  let staging
  let backup
  try {
    await mkdir(dirname(output), { recursive: true })
    const kind = await existingOutputKind(output)
    if (kind === 'symlink') fail('projection-output-symlink')
    if (kind === 'file') fail('projection-output-not-directory')
    staging = await mkdtemp(join(dirname(output), '.re-react-projection-'))
    for (const name of names) {
      await writeFile(join(staging, name), built.value.files[name], 'utf8')
    }
    if (kind === 'directory') {
      backup = `${output}.previous-${process.pid}-${writeSequence++}`
      await rename(output, backup)
    }
    await rename(staging, output)
    staging = undefined
    if (backup !== undefined) await rm(backup, { force: true, recursive: true })
    return { ...built, written: true }
  } catch (error) {
    if (staging !== undefined) await rm(staging, { force: true, recursive: true })
    if (backup !== undefined) {
      await rm(output, { force: true, recursive: true })
      await rename(backup, output)
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

export async function verifyReactClientProjection(contract, options = {}) {
  const built = buildReactClientProjection(contract, options)
  if (!built.ok) return built
  const output = options.output
  if (typeof output !== 'string' || output.length === 0) {
    return { diagnostics: [{ code: 'projection-output-required' }], ok: false }
  }
  try {
    const directory = await lstat(output)
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      return { diagnostics: [{ code: 'projection-output-not-directory' }], ok: false }
    }
    const names = (await readdir(output)).sort(compareText)
    const expected = Object.keys(built.value.files).sort(compareText)
    if (!sameStrings(names, expected)) {
      return { diagnostics: [{ code: 'projection-artifact-file-set-drift' }], ok: false }
    }
    for (const [path, source] of Object.entries(built.value.files)) {
      const file = await lstat(join(output, path))
      if (!file.isFile() || file.isSymbolicLink()) {
        return {
          diagnostics: [{ code: 'projection-artifact-not-regular-file', path }],
          ok: false,
        }
      }
      const actual = await readFile(join(output, path), 'utf8')
      if (actual !== source) {
        return { diagnostics: [{ code: 'projection-artifact-drift', path }], ok: false }
      }
    }
    const parsed = validateReactClientProjectionManifest(
      JSON.parse(built.value.files['react-client.json']),
    )
    if (!parsed.ok) return parsed
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

function renderOperations(entries) {
  const lines = [
    '// Generated by Revia React client projection.',
    '// Source contract: projection.json (re.interface-projection-manifest@0.1.0).',
    "import { useCallback, useState } from 'react'",
    '',
    "import type { ProjectionClient } from './client.js'",
    `import type { ${[...new Set(entries.flatMap((entry) => [
      entry.errorName,
      entry.inputName,
      entry.outputName,
    ]))].sort(compareText).join(', ')} } from './types.js'`,
    '',
  ]
  for (const entry of entries) {
    const stateName = `${capitalize(entry.methodName)}State`
    lines.push(
      `export type ${stateName} =`,
      "  | { readonly status: 'idle' }",
      "  | { readonly status: 'pending' }",
      `  | { readonly status: 'ok'; readonly value: ${entry.outputName} }`,
      `  | { readonly status: 'err'; readonly error: ${entry.errorName} }`,
      '',
      `export function use${capitalize(entry.methodName)}(`,
      '  client: ProjectionClient,',
      '  options: { token?: string; idempotencyKey?: string } = {},',
      `): { readonly state: ${stateName}; readonly submit: (input: ${entry.inputName}) => Promise<void> } {`,
      `  const [state, setState] = useState<${stateName}>({ status: 'idle' })`,
      '  const submit = useCallback(',
      `    async (input: ${entry.inputName}) => {`,
      "      setState({ status: 'pending' })",
      `      const outcome = await client.${entry.methodName}(input, options)`,
      "      if (outcome.kind === 'ok') setState({ status: 'ok', value: outcome.value })",
      "      else setState({ status: 'err', error: outcome.error })",
      '    },',
      '    [client, options.token, options.idempotencyKey],',
      '  )',
      '  return { state, submit }',
      '}',
      '',
    )
  }
  return lines.join('\n')
}

function renderPanels(entries) {
  const lines = [
    '// Generated by Revia React client projection.',
    '// Source contract: projection.json (re.interface-projection-manifest@0.1.0).',
    "import { useState, type FormEvent } from 'react'",
    '',
    "import type { ProjectionClient } from './client.js'",
    `import { ${entries.flatMap((entry) => [
      `use${capitalize(entry.methodName)}`,
      `type ${capitalize(entry.methodName)}State`,
    ]).join(', ')} } from './operations.js'`,
    '',
  ]
  for (const entry of entries) {
    const panel = `${capitalize(entry.methodName)}Panel`
    const stateName = `${capitalize(entry.methodName)}State`
    lines.push(
      `export interface ${panel}Props {`,
      '  readonly client: ProjectionClient',
      '  readonly token?: string',
      '  readonly idempotencyKey?: string',
      '}',
      '',
      `export function ${panel}({ client, token, idempotencyKey }: ${panel}Props) {`,
      `  const { state, submit } = use${capitalize(entry.methodName)}(client, { token, idempotencyKey })`,
      ...entry.fields.flatMap(renderFieldState),
      '  function handleSubmit(event: FormEvent<HTMLFormElement>) {',
      '    event.preventDefault()',
      `    void submit(${renderInputLiteral(entry.fields)})`,
      '  }',
      '  return (',
      '    <form onSubmit={handleSubmit}>',
      ...entry.fields.flatMap(renderFieldControl),
      '      <button type="submit" disabled={state.status === \'pending\'}>',
      `        ${labelOf(entry.methodName)}`,
      '      </button>',
      `      <${capitalize(entry.methodName)}Outcome state={state} />`,
      '    </form>',
      '  )',
      '}',
      '',
      `function ${capitalize(entry.methodName)}Outcome({ state }: { readonly state: ${stateName} }) {`,
      "  if (state.status === 'idle') return null",
      "  if (state.status === 'pending') return <p role=\"status\">Pending</p>",
      "  if (state.status === 'ok') {",
      '    return (',
      '      <dl role="status">',
      ...entry.resultFields.flatMap((field) => [
        `        <dt>${labelOf(field.name)}</dt>`,
        `        <dd>{String(${field.access})}</dd>`,
      ]),
      '      </dl>',
      '    )',
      '  }',
      "  return <p role=\"alert\">{state.error.variant}</p>",
      '}',
      '',
    )
  }
  return lines.join('\n')
}

function renderFieldState(field) {
  const setter = `set${capitalize(field.name)}`
  if (field.control === 'checkbox') {
    return [`  const [${field.name}, ${setter}] = useState(${String(field.initial)})`]
  }
  if (field.control === 'select') {
    return [`  const [${field.name}, ${setter}] = useState<${field.union}>(${singleQuote(field.variants[0])})`]
  }
  return [`  const [${field.name}, ${setter}] = useState('')`]
}

function renderFieldControl(field) {
  const setter = `set${capitalize(field.name)}`
  const label = labelOf(field.name)
  if (field.control === 'checkbox') {
    return [
      '      <label>',
      '        <input',
      '          type="checkbox"',
      `          checked={${field.name}}`,
      `          onChange={(event) => ${setter}(event.currentTarget.checked)}`,
      '        />',
      `        ${label}`,
      '      </label>',
    ]
  }
  if (field.control === 'select') {
    return [
      '      <label>',
      `        ${label}`,
      '        <select',
      `          value={${field.name}}`,
      `          onChange={(event) => ${setter}(event.currentTarget.value as ${field.union})}`,
      '        >',
      ...field.variants.map((variant) => `          <option value="${variant}">${variant}</option>`),
      '        </select>',
      '      </label>',
    ]
  }
  const inputMode = field.control === 'integer' ? 'numeric' : 'decimal'
  return [
    '      <label>',
    `        ${label}`,
    '        <input',
    '          required',
    `          inputMode="${inputMode}"`,
    `          value={${field.name}}`,
    `          onChange={(event) => ${setter}(event.currentTarget.value)}`,
    '        />',
    '      </label>',
  ]
}

function renderInputLiteral(fields) {
  const parts = fields.map((field) => (field.control === 'select'
    ? `${field.name}: { variant: ${field.name} }`
    : `${field.name}: ${field.name}`))
  return `{ ${parts.join(', ')} }`
}

function describeField(field, names, declarations, operation) {
  const name = field?.name
  if (typeof name !== 'string' || !METHOD_NAME.test(name)) {
    fail('react-projection-contract-invalid', { operation })
  }
  const type = field.type
  if (type?.kind === 'decimal') {
    return { control: 'decimal', name, scale: type.scale }
  }
  if (type?.kind === 'primitive') {
    if (PRIMITIVE_TEXT.has(type.name)) return { control: 'text', name }
    if (type.name === 'int') return { control: 'integer', name }
    if (type.name === 'bool') return { control: 'checkbox', initial: false, name }
    fail('react-projection-unsupported-field-type', { field: name, operation, type: type.name })
  }
  if (type?.kind === 'declared') {
    const declaration = declarations.get(type.declaration_digest)
    const body = declaration?.declaration?.body
    if (body?.kind !== 'sum') {
      fail('react-projection-unsupported-field-type', {
        field: name,
        operation,
        type: names.get(type.declaration_digest) ?? 'declared',
      })
    }
    const payload = body.variants.find((variant) => variant.type !== undefined)
    if (payload !== undefined) {
      fail('react-projection-unsupported-field-type', { field: name, operation, type: 'sum-payload' })
    }
    const variants = [...body.variants].map((variant) => variant.name).sort(compareText)
    return {
      // The union is inlined at every use site, so the declaration name is
      // never referenced and importing it would ship an unused binding.
      control: 'select',
      name,
      union: variants.map((variant) => singleQuote(variant)).join(' | '),
      variants,
    }
  }
  fail('react-projection-unsupported-field-type', {
    field: name,
    operation,
    type: String(type?.kind ?? 'unknown'),
  })
}

function describeResultFields(declaration, names, declarations, operation) {
  if (declaration?.declaration?.body?.kind !== 'record') {
    fail('react-projection-unsupported-input', { operation, role: 'output' })
  }
  return declaration.declaration.body.fields.map((field) => {
    const access = `state.value.${field.name}`
    const described = describeField(field, names, declarations, operation)
    return {
      access: described.control === 'select' ? `${access}.variant` : access,
      name: field.name,
    }
  })
}

function resolveDeclaredName(type, names, declarations, role) {
  if (type?.kind !== 'declared') {
    fail('react-projection-unsupported-input', { role })
  }
  const declaration = declarations.get(type.declaration_digest)
  if (declaration === undefined) fail('react-projection-type-declaration-not-found', { role })
  const name = names.get(type.declaration_digest)
  if (name === undefined) fail('react-projection-type-declaration-not-found', { role })
  return name
}

function typeNameMap(types) {
  const names = new Map()
  for (const entry of types) {
    const digest = entry?.declaration_digest
    const name = entry?.name
    if (typeof digest !== 'string' || typeof name !== 'string') continue
    const local = name.slice(name.lastIndexOf('.') + 1)
    names.set(digest, capitalize(local))
  }
  return names
}

async function existingOutputKind(path) {
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) return 'symlink'
    if (entry.isDirectory()) return 'directory'
    return 'file'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

function labelOf(name) {
  return capitalize(String(name).replaceAll('_', ' '))
}

function singleQuote(value) {
  const text = value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
  return `'${text}'`
}

function capitalize(value) {
  return value[0].toUpperCase() + value.slice(1)
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

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
}

function compareText(left, right) {
  return Buffer.from(String(left), 'utf8').compare(Buffer.from(String(right), 'utf8'))
}

function requireDigest(value, code) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(code)
  return value
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}
