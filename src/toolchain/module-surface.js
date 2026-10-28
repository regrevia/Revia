import { Buffer } from 'node:buffer'

import {
  agentAdapterContractDigest,
  validateAgentAdapterContract,
} from '../host/agent-adapter-contract.js'
import {
  agentContractDigest,
  validateAgentContract,
} from './agent-contract.js'
import {
  businessFunctionDigest,
  validateBusinessFunction,
} from './business-function.js'
import { validatePackageManifest } from './module-contract.js'
import {
  taskContractDigest,
  validateTaskContract,
} from './task-contract.js'
import {
  typeDeclarationDigest,
  validateTypeDeclaration,
} from './type-contract.js'

const HEADER = 're 1.0 compact'
const NAME = '[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)*'
const BINDING = '[a-z][a-z0-9_]*'
const DIGEST = 'sha256:[0-9a-f]{64}'
const UID = '[a-z2-7]{25}[aeimquy4]'
const REFERENCE = `${NAME}@[0-9]+\\.[0-9]+\\.[0-9]+`
const MODULE = new RegExp(`^module (${NAME})$`, 'd')
const INTERNAL_IMPORT = new RegExp(
  `^import (${NAME})@(${DIGEST}) as (${BINDING})$`,
  'd',
)
const INTERNAL_IMPORT_WITHOUT_DIGEST = new RegExp(
  `^import (${NAME}) as (${BINDING})$`,
  'd',
)
const EXTERNAL_IMPORT = new RegExp(
  `^import external (${NAME})@(${DIGEST}) from (${DIGEST}) as (${BINDING})$`,
  'd',
)
const EXPORT = new RegExp(`^export (${BINDING})$`, 'd')
const CAPABILITY = new RegExp(
  `^capability (${NAME}) (${BINDING}) (${REFERENCE}) uid (${UID})$`,
  'd',
)
const ERROR = new RegExp(`^error (${NAME}) uid (${UID})$`, 'd')
const STATE = new RegExp(`^state (${BINDING}) uid (${UID})$`, 'd')
const TASK = new RegExp(`^task (${NAME}) id (${DIGEST})$`, 'd')
const EDGE = new RegExp(`^edge (${NAME}) -> (${NAME}) uid (${UID})$`, 'd')
const EXECUTION = new RegExp(
  `^(task-contract|adapter-contract|run-case|type-declaration|function-declaration|agent-declaration) (${NAME}) (\\{.*\\})$`,
  'd',
)

export function lowerModuleSurface(source, manifest, { file = '<module-surface>' } = {}) {
  if (typeof source !== 'string') {
    throw new TypeError('module surface source must be a string')
  }
  const contract = validatePackageManifest(manifest)
  if (!contract.ok) {
    return {
      diagnostics: [{
        code: 'invalid-module-contract',
        contract_diagnostics: contract.diagnostics,
        ...spanAt(source, 0, 0, file),
      }],
      ok: false,
    }
  }
  const parsed = parseSurface(source, file)
  if (!parsed.ok) return parsed
  return bindSurface(parsed.value, manifest, source, file)
}

export function lowerValidatedModuleSurface(
  source,
  manifest,
  moduleEntry,
  { file = '<module-surface>' } = {},
) {
  if (typeof source !== 'string'
    || moduleEntry === null
    || typeof moduleEntry !== 'object'
    || Array.isArray(moduleEntry)
    || typeof moduleEntry.name !== 'string') {
    throw new TypeError('validated module surface input is invalid')
  }
  const parsed = parseSurface(source, file)
  if (!parsed.ok) return parsed
  return bindSurface(parsed.value, manifest, source, file, moduleEntry)
}

function parseSurface(source, file) {
  const lines = sourceLines(source)
  if (lines.length === 0 || lines[0].text !== HEADER) {
    const end = lines[0]?.text.length ?? 0
    return rejected('unsupported-module-surface-header', source, 0, end, file)
  }
  const declarations = []
  for (const line of lines.slice(1)) {
    const leading = line.text.match(/^[ \t]*/)[0].length
    const trailing = line.text.match(/[ \t]*$/)[0].length
    const end = trailing === 0 ? line.text.length : line.text.length - trailing
    const text = line.text.slice(leading, end)
    if (text.length === 0) continue
    const start = line.start + leading
    if (text.startsWith('//')) continue

    const moduleMatch = MODULE.exec(text)
    if (moduleMatch !== null) {
      declarations.push({
        kind: 'module',
        name: capture(moduleMatch, 1, start, source, file),
      })
      continue
    }
    const externalMatch = EXTERNAL_IMPORT.exec(text)
    if (externalMatch !== null) {
      declarations.push({
        binding: capture(externalMatch, 4, start, source, file),
        interface_digest: capture(externalMatch, 2, start, source, file),
        kind: 'import',
        module: capture(externalMatch, 1, start, source, file),
        package_digest: capture(externalMatch, 3, start, source, file),
        scope: 'external',
      })
      continue
    }
    const internalMatch = INTERNAL_IMPORT.exec(text)
    if (internalMatch !== null) {
      declarations.push({
        binding: capture(internalMatch, 3, start, source, file),
        interface_digest: capture(internalMatch, 2, start, source, file),
        kind: 'import',
        module: capture(internalMatch, 1, start, source, file),
        scope: 'package',
      })
      continue
    }
    const unpinnedInternalMatch = INTERNAL_IMPORT_WITHOUT_DIGEST.exec(text)
    if (unpinnedInternalMatch !== null) {
      const [tokenStart, tokenEnd] = unpinnedInternalMatch.indices[1]
      return rejected(
        'missing-module-interface-digest',
        source,
        start + tokenStart,
        start + tokenEnd,
        file,
      )
    }
    const exportMatch = EXPORT.exec(text)
    if (exportMatch !== null) {
      declarations.push({
        kind: 'export',
        name: capture(exportMatch, 1, start, source, file),
      })
      continue
    }
    const capabilityMatch = CAPABILITY.exec(text)
    if (capabilityMatch !== null) {
      declarations.push({
        instance: capture(capabilityMatch, 1, start, source, file),
        kind: 'capability',
        member: capture(capabilityMatch, 2, start, source, file),
        reference: capture(capabilityMatch, 3, start, source, file),
        uid: capture(capabilityMatch, 4, start, source, file),
      })
      continue
    }
    const errorMatch = ERROR.exec(text)
    if (errorMatch !== null) {
      declarations.push({
        kind: 'error',
        name: capture(errorMatch, 1, start, source, file),
        uid: capture(errorMatch, 2, start, source, file),
      })
      continue
    }
    const stateMatch = STATE.exec(text)
    if (stateMatch !== null) {
      declarations.push({
        kind: 'state',
        name: capture(stateMatch, 1, start, source, file),
        uid: capture(stateMatch, 2, start, source, file),
      })
      continue
    }
    const taskMatch = TASK.exec(text)
    if (taskMatch !== null) {
      declarations.push({
        kind: 'task',
        name: capture(taskMatch, 1, start, source, file),
        task_id: capture(taskMatch, 2, start, source, file),
      })
      continue
    }
    const edgeMatch = EDGE.exec(text)
    if (edgeMatch !== null) {
      declarations.push({
        from: capture(edgeMatch, 1, start, source, file),
        kind: 'edge',
        to: capture(edgeMatch, 2, start, source, file),
        uid: capture(edgeMatch, 3, start, source, file),
      })
      continue
    }
    const executionMatch = EXECUTION.exec(text)
    if (executionMatch !== null) {
      const raw = executionMatch[3]
      let value
      try {
        value = JSON.parse(raw)
      } catch {
        const [jsonStart, jsonEnd] = executionMatch.indices[3]
        return rejected(
          'invalid-module-execution-json',
          source,
          start + jsonStart,
          start + jsonEnd,
          file,
        )
      }
      if (canonicalJson(value) !== raw) {
        const [jsonStart, jsonEnd] = executionMatch.indices[3]
        return rejected(
          'noncanonical-module-execution-json',
          source,
          start + jsonStart,
          start + jsonEnd,
          file,
        )
      }
      declarations.push({
        kind: executionMatch[1],
        name: capture(executionMatch, 2, start, source, file),
        value,
      })
      continue
    }
    if (/^export[ \t]+\*/.test(text)) {
      const star = text.indexOf('*')
      return rejected(
        'transparent-reexport-not-supported',
        source,
        start + star,
        start + star + 1,
        file,
      )
    }
    const token = /[^ \t]+/u.exec(text)
    return rejected(
      text.startsWith('import ')
        ? 'invalid-module-import'
        : text.startsWith('export ')
          ? 'invalid-module-export'
          : text.startsWith('capability ')
            ? 'invalid-module-capability'
            : text.startsWith('error ')
              ? 'invalid-module-error'
              : text.startsWith('state ')
                ? 'invalid-module-state'
                : text.startsWith('task ')
                  ? 'invalid-module-task'
                  : text.startsWith('edge ')
                    ? 'invalid-module-edge'
                    : text.startsWith('task-contract ')
                      || text.startsWith('adapter-contract ')
                      || text.startsWith('run-case ')
                      || text.startsWith('type-declaration ')
                      || text.startsWith('function-declaration ')
                      || text.startsWith('agent-declaration ')
                      ? 'invalid-module-execution-declaration'
          : 'unsupported-module-surface-construct',
      source,
      start + (token?.index ?? 0),
      start + (token?.index ?? 0) + (token?.[0].length ?? 0),
      file,
    )
  }
  const modules = declarations.filter(({ kind }) => kind === 'module')
  if (modules.length !== 1) {
    const duplicate = modules[1]?.name ?? modules[0]?.name
    return rejected(
      modules.length === 0 ? 'missing-module-declaration' : 'duplicate-module-declaration',
      source,
      duplicate?.start ?? HEADER.length + 1,
      duplicate?.end ?? HEADER.length + 1,
      file,
    )
  }
  const firstDeclaration = declarations[0]
  if (firstDeclaration.kind !== 'module') {
    const token = declarationToken(firstDeclaration)
    return rejected('module-declaration-must-be-first', source, token.start, token.end, file)
  }
  return {
    ok: true,
    value: {
      exports: declarations.filter(({ kind }) => kind === 'export'),
      imports: declarations.filter(({ kind }) => kind === 'import'),
      module: modules[0],
      execution: declarations.filter(({ kind }) => (
        kind === 'task-contract'
        || kind === 'adapter-contract'
        || kind === 'run-case'
      )),
      business: declarations.filter(({ kind }) => (
        kind === 'type-declaration'
        || kind === 'function-declaration'
        || kind === 'agent-declaration'
      )),
      review: declarations.filter(({ kind }) => (
        kind === 'capability'
        || kind === 'edge'
        || kind === 'error'
        || kind === 'state'
        || kind === 'task'
      )),
    },
  }
}

function bindSurface(surface, manifest, source, file, trustedModuleEntry = null) {
  const moduleName = surface.module.name.value
  const moduleEntry = trustedModuleEntry
    ?? manifest.modules.find(({ name }) => name === moduleName)
  if (moduleEntry === undefined) {
    return rejected(
      'source-module-not-in-package',
      source,
      surface.module.name.start,
      surface.module.name.end,
      file,
    )
  }
  if (moduleEntry.name !== moduleName) {
    return rejected(
      'source-module-not-in-package',
      source,
      surface.module.name.start,
      surface.module.name.end,
      file,
    )
  }
  const duplicateImport = secondDuplicate(surface.imports, ({ binding }) => binding.value)
  if (duplicateImport !== undefined) {
    return rejected(
      'duplicate-module-binding',
      source,
      duplicateImport.binding.start,
      duplicateImport.binding.end,
      file,
    )
  }
  const duplicateExport = secondDuplicate(surface.exports, ({ name }) => name.value)
  if (duplicateExport !== undefined) {
    return rejected(
      'duplicate-module-export',
      source,
      duplicateExport.name.start,
      duplicateExport.name.end,
      file,
    )
  }

  const seenBindings = new Map()
  for (const imported of surface.imports) {
    const binding = imported.binding.value
    seenBindings.set(binding, imported)
    const expected = moduleEntry.interface.dependencies.find(
      (dependency) => dependency.binding === binding,
    )
    if (expected === undefined) {
      return rejected(
        'source-import-not-in-interface',
        source,
        imported.binding.start,
        imported.binding.end,
        file,
        { binding },
      )
    }
    const actual = dependencyValue(imported)
    if (!sameDependency(actual, expected)) {
      const pin = firstMismatchedPin(imported, expected)
      return rejected(
        'source-import-pin-mismatch',
        source,
        pin.start,
        pin.end,
        file,
        { binding },
      )
    }
  }
  for (const dependency of moduleEntry.interface.dependencies) {
    if (!seenBindings.has(dependency.binding)) {
      return rejected(
        'source-import-missing',
        source,
        surface.module.name.start,
        surface.module.name.end,
        file,
        { binding: dependency.binding },
      )
    }
  }

  const seenExports = new Map()
  for (const exported of surface.exports) {
    const name = exported.name.value
    seenExports.set(name, exported)
    if (!moduleEntry.interface.exports.some((candidate) => candidate.name === name)) {
      return rejected(
        'source-export-not-in-interface',
        source,
        exported.name.start,
        exported.name.end,
        file,
        { export: name },
      )
    }
  }
  for (const exported of moduleEntry.interface.exports) {
    if (!seenExports.has(exported.name)) {
      return rejected(
        'source-export-missing',
        source,
        surface.module.name.start,
        surface.module.name.end,
        file,
        { export: exported.name },
      )
    }
  }
  const review = bindReviewFacts(surface.review, moduleName, source, file)
  if (!review.ok) return review
  const execution = bindExecutionDeclarations(
    surface.execution,
    moduleName,
    source,
    file,
  )
  if (!execution.ok) return execution
  const business = bindBusinessDeclarations(
    surface.business,
    moduleName,
    source,
    file,
  )
  if (!business.ok) return business
  const hasReviewFacts = surface.review.length > 0
  const hasExecutionDeclarations = surface.execution.length > 0
  const hasBusinessDeclarations = surface.business.length > 0
  return {
    ok: true,
    value: {
      ...(hasBusinessDeclarations ? business.value : {}),
      ...(hasExecutionDeclarations ? execution.value : {}),
      ...(hasReviewFacts ? review.value : {}),
      interface: structuredClone(moduleEntry.interface),
      interface_digest: moduleEntry.interface_digest,
      module: moduleEntry.name,
      schema: hasBusinessDeclarations
        ? 're.module-surface-lowering@0.4.0'
        : hasExecutionDeclarations
          ? 're.module-surface-lowering@0.3.0'
        : hasReviewFacts
          ? 're.module-surface-lowering@0.2.0'
          : 're.module-surface-lowering@0.1.0',
    },
  }
}

function bindBusinessDeclarations(declarations, moduleName, source, file) {
  const byKind = {
    agents: declarations.filter(({ kind }) => kind === 'agent-declaration'),
    functions: declarations.filter(({ kind }) => kind === 'function-declaration'),
    types: declarations.filter(({ kind }) => kind === 'type-declaration'),
  }
  for (const values of Object.values(byKind)) {
    const duplicate = secondDuplicate(values, ({ name }) => name.value)
    if (duplicate !== undefined) {
      return rejected(
        'duplicate-module-business-declaration',
        source,
        duplicate.name.start,
        duplicate.name.end,
        file,
      )
    }
  }
  const prefix = `${moduleName}.`
  for (const declaration of declarations) {
    if (declaration.name.value !== moduleName
      && !declaration.name.value.startsWith(prefix)) {
      return rejected(
        'module-business-declaration-detached',
        source,
        declaration.name.start,
        declaration.name.end,
        file,
      )
    }
  }
  const typeDeclarations = []
  for (const declaration of byKind.types) {
    const validated = validateTypeDeclaration(declaration.value)
    if (!validated.ok) {
      return executionRejected(
        'invalid-module-type-declaration',
        declaration,
        validated.diagnostics,
        source,
        file,
      )
    }
    if (declaration.value.module !== moduleName
      || declaration.name.value !== `${moduleName}.${declaration.value.name}`) {
      return rejected(
        'module-business-declaration-detached',
        source,
        declaration.name.start,
        declaration.name.end,
        file,
      )
    }
    typeDeclarations.push({
      declaration: structuredClone(declaration.value),
      declaration_digest: typeDeclarationDigest(declaration.value),
      name: declaration.name.value,
    })
  }
  const functionDeclarations = []
  for (const declaration of byKind.functions) {
    const validated = validateBusinessFunction(declaration.value)
    if (!validated.ok) {
      return executionRejected(
        'invalid-module-function-declaration',
        declaration,
        validated.diagnostics,
        source,
        file,
      )
    }
    if (validated.value.module !== moduleName
      || declaration.name.value !== `${moduleName}.${validated.value.name}`) {
      return rejected(
        'module-business-declaration-detached',
        source,
        declaration.name.start,
        declaration.name.end,
        file,
      )
    }
    functionDeclarations.push({
      declaration: validated.value,
      declaration_digest: businessFunctionDigest(declaration.value),
      name: declaration.name.value,
    })
  }
  const agentDeclarations = []
  for (const declaration of byKind.agents) {
    const validated = validateAgentContract(declaration.value)
    if (!validated.ok) {
      return executionRejected(
        'invalid-module-agent-declaration',
        declaration,
        validated.diagnostics,
        source,
        file,
      )
    }
    if (validated.value.module !== moduleName
      || declaration.name.value !== validated.value.agent) {
      return rejected(
        'module-business-declaration-detached',
        source,
        declaration.name.start,
        declaration.name.end,
        file,
      )
    }
    agentDeclarations.push({
      ...validated.value,
      declaration_digest: agentContractDigest(declaration.value),
      name: declaration.name.value,
    })
  }
  return {
    ok: true,
    value: {
      agent_declarations: agentDeclarations.sort(compareNamed),
      function_declarations: functionDeclarations.sort(compareNamed),
      type_declarations: typeDeclarations.sort(compareNamed),
    },
  }
}

function bindExecutionDeclarations(declarations, moduleName, source, file) {
  const byKind = {
    adapters: declarations.filter(({ kind }) => kind === 'adapter-contract'),
    cases: declarations.filter(({ kind }) => kind === 'run-case'),
    tasks: declarations.filter(({ kind }) => kind === 'task-contract'),
  }
  for (const values of Object.values(byKind)) {
    const duplicate = secondDuplicate(values, ({ name }) => name.value)
    if (duplicate !== undefined) {
      return rejected(
        'duplicate-module-execution-declaration',
        source,
        duplicate.name.start,
        duplicate.name.end,
        file,
      )
    }
  }
  const prefix = `${moduleName}.`
  for (const declaration of declarations) {
    if (!declaration.name.value.startsWith(prefix)) {
      return rejected(
        'module-execution-contract-detached',
        source,
        declaration.name.start,
        declaration.name.end,
        file,
      )
    }
  }
  const taskContracts = []
  for (const declaration of byKind.tasks) {
    const validated = validateTaskContract(declaration.value)
    if (!validated.ok) {
      return executionRejected(
        'invalid-module-task-contract',
        declaration,
        validated.diagnostics,
        source,
        file,
      )
    }
    if (validated.value.module !== moduleName
      || validated.value.agent !== moduleName) {
      return rejected(
        'module-execution-contract-detached',
        source,
        declaration.name.start,
        declaration.name.end,
        file,
      )
    }
    taskContracts.push({
      contract: executionContract(validated.value),
      contract_digest: taskContractDigest(declaration.value),
      name: declaration.name.value,
    })
  }
  const adapterContracts = []
  for (const declaration of byKind.adapters) {
    const validated = validateAgentAdapterContract(declaration.value)
    if (!validated.ok) {
      return executionRejected(
        'invalid-module-adapter-contract',
        declaration,
        validated.diagnostics,
        source,
        file,
      )
    }
    if (validated.value.module !== moduleName
      || validated.value.agent !== moduleName) {
      return rejected(
        'module-execution-contract-detached',
        source,
        declaration.name.start,
        declaration.name.end,
        file,
      )
    }
    adapterContracts.push({
      contract: executionContract(validated.value),
      contract_digest: agentAdapterContractDigest(declaration.value),
      name: declaration.name.value,
    })
  }
  const runCases = []
  for (const declaration of byKind.cases) {
    const validated = validateRunCase(declaration.value, moduleName)
    if (!validated.ok) {
      return executionRejected(
        'invalid-module-run-case',
        declaration,
        validated.diagnostics,
        source,
        file,
      )
    }
    runCases.push({ name: declaration.name.value, ...validated.value })
  }
  return {
    ok: true,
    value: {
      adapter_contracts: adapterContracts.sort(compareNamed),
      run_cases: runCases.sort(compareNamed),
      task_contracts: taskContracts.sort(compareNamed),
    },
  }
}

function validateRunCase(value, moduleName) {
  try {
    exactFields(
      value,
      ['adapter', 'request', 'responses', 'schema', 'task', 'function'],
      ['function'],
    )
    if (value.schema !== 're.project-run-case@0.1.0'
      || typeof value.adapter !== 'string'
      || typeof value.task !== 'string'
      || (value.function !== undefined
        && (typeof value.function !== 'string'
          || !value.function.startsWith(`${moduleName}.`)))
      || !value.adapter.startsWith(`${moduleName}.`)
      || !value.task.startsWith(`${moduleName}.`)) {
      throw new TypeError('invalid run case identity')
    }
    exactFields(value.request, [
      'agent', 'idempotency_key', 'input', 'module', 'node_uid',
    ])
    if (value.request.agent !== moduleName
      || value.request.module !== moduleName
      || typeof value.request.idempotency_key !== 'string'
      || value.request.idempotency_key.length === 0
      || !new RegExp(`^${UID}$`).test(value.request.node_uid)
      || value.request.input === null
      || typeof value.request.input !== 'object'
      || Array.isArray(value.request.input)
      || !Array.isArray(value.responses)
      || value.responses.length === 0) {
      throw new TypeError('invalid run case request')
    }
    for (const response of value.responses) {
      exactFields(response, ['input', 'outcome'])
      if (response.input === null || typeof response.input !== 'object'
        || Array.isArray(response.input)
        || response.outcome?.kind !== 'value'
        || !['ok', 'err'].includes(response.outcome?.value?.kind)) {
        throw new TypeError('invalid run case response')
      }
    }
    return { ok: true, value: structuredClone(value) }
  } catch {
    return { diagnostics: [{ code: 'invalid-module-run-case' }], ok: false }
  }
}

function executionContract(value) {
  const { contract_digest, ...contract } = value
  return contract
}

function executionRejected(code, declaration, diagnostics, source, file) {
  return rejected(
    code,
    source,
    declaration.name.start,
    declaration.name.end,
    file,
    { contract_diagnostics: diagnostics },
  )
}

function compareNamed(left, right) {
  return compareText(left.name, right.name)
}

function compareText(left, right) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
}

function bindReviewFacts(declarations, moduleName, source, file) {
  const byKind = {
    capability: declarations.filter(({ kind }) => kind === 'capability'),
    edge: declarations.filter(({ kind }) => kind === 'edge'),
    error: declarations.filter(({ kind }) => kind === 'error'),
    state: declarations.filter(({ kind }) => kind === 'state'),
    task: declarations.filter(({ kind }) => kind === 'task'),
  }
  for (const [kind, values, keyOf] of [
    ['capability', byKind.capability, ({ instance, member }) => `${instance.value}\0${member.value}`],
    ['edge', byKind.edge, ({ uid }) => uid.value],
    ['error', byKind.error, ({ name }) => name.value],
    ['state', byKind.state, ({ name }) => name.value],
    ['task', byKind.task, ({ name }) => name.value],
  ]) {
    const duplicate = secondDuplicate(values, keyOf)
    if (duplicate !== undefined) {
      const token = declarationToken(duplicate)
      return rejected(
        `duplicate-module-${kind}`,
        source,
        token.start,
        token.end,
        file,
      )
    }
  }
  const withUid = declarations.filter(({ uid }) => uid !== undefined)
  const duplicateUid = secondDuplicate(withUid, ({ uid }) => uid.value)
  if (duplicateUid !== undefined) {
    return rejected(
      'duplicate-module-review-uid',
      source,
      duplicateUid.uid.start,
      duplicateUid.uid.end,
      file,
    )
  }
  const prefix = `${moduleName}.`
  for (const declaration of declarations) {
    const owned = declaration.kind === 'capability'
      ? declaration.instance
      : declaration.kind === 'edge'
        ? [declaration.from, declaration.to].find(({ value }) => !value.startsWith(prefix))
        : declaration.kind === 'state'
          ? null
          : declaration.name
    if (owned !== null && owned !== undefined && !owned.value.startsWith(prefix)) {
      return rejected(
        'module-review-fact-detached',
        source,
        owned.start,
        owned.end,
        file,
        { kind: declaration.kind, module: moduleName },
      )
    }
  }
  return {
    ok: true,
    value: {
      capabilities: byKind.capability.map((entry) => ({
        instance: entry.instance.value,
        member: entry.member.value,
        reference: entry.reference.value,
        uid: entry.uid.value,
      })).sort((left, right) => compareReview(left, right)),
      edges: byKind.edge.map((entry) => ({
        from: entry.from.value,
        to: entry.to.value,
        uid: entry.uid.value,
      })).sort((left, right) => compareReview(left, right)),
      errors: byKind.error.map((entry) => ({
        name: entry.name.value,
        uid: entry.uid.value,
      })).sort((left, right) => compareReview(left, right)),
      states: byKind.state.map((entry) => ({
        name: entry.name.value,
        uid: entry.uid.value,
      })).sort((left, right) => compareReview(left, right)),
      tasks: byKind.task.map((entry) => ({
        name: entry.name.value,
        task_id: entry.task_id.value,
      })).sort((left, right) => compareReview(left, right)),
    },
  }
}

function compareReview(left, right) {
  return compareText(reviewKey(left), reviewKey(right))
}

function reviewKey(value) {
  if (Object.hasOwn(value, 'reference')) {
    return `${value.instance}\u0000${value.member}\u0000${value.reference}\u0000${value.uid}`
  }
  if (Object.hasOwn(value, 'task_id')) {
    return `${value.name}\u0000${value.task_id}`
  }
  if (Object.hasOwn(value, 'from')) {
    return `${value.from}\u0000${value.to}\u0000${value.uid}`
  }
  return `${value.name}\u0000${value.uid}`
}

function exactFields(value, expected, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid fields')
  }
  const actual = Object.keys(value).sort(compareText)
  const wanted = [...expected].sort(compareText)
  const required = wanted.filter((field) => !optional.includes(field))
  if (required.some((field) => !actual.includes(field))
    || actual.some((field) => !wanted.includes(field))) {
    throw new TypeError('invalid fields')
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function secondDuplicate(values, keyOf) {
  const seen = new Set()
  for (const value of values) {
    const key = keyOf(value)
    if (seen.has(key)) return value
    seen.add(key)
  }
  return undefined
}

function dependencyValue(imported) {
  return {
    binding: imported.binding.value,
    interface_digest: imported.interface_digest.value,
    module: imported.module.value,
    ...(imported.scope === 'external'
      ? { package_digest: imported.package_digest.value }
      : {}),
    scope: imported.scope,
  }
}

function sameDependency(left, right) {
  return (
    left.binding === right.binding &&
    left.interface_digest === right.interface_digest &&
    left.module === right.module &&
    left.package_digest === right.package_digest &&
    left.scope === right.scope
  )
}

function firstMismatchedPin(imported, expected) {
  if (imported.module.value !== expected.module) return imported.module
  if (imported.interface_digest.value !== expected.interface_digest) {
    return imported.interface_digest
  }
  if (imported.scope !== expected.scope) return imported.module
  return imported.package_digest ?? imported.module
}

function capture(match, group, base, source, file) {
  const [start, end] = match.indices[group]
  return {
    end: base + end,
    span: spanAt(source, base + start, base + end, file),
    start: base + start,
    value: match[group],
  }
}

function declarationToken(declaration) {
  return declaration.name ?? declaration.binding ?? declaration.module
}

function sourceLines(source) {
  const result = []
  let start = 0
  for (const text of source.split('\n')) {
    result.push({ start, text })
    start += text.length + 1
  }
  return result
}

function rejected(code, source, start, end, file, context = {}) {
  return {
    diagnostics: [{ code, ...context, ...spanAt(source, start, end, file) }],
    ok: false,
  }
}

function spanAt(source, start, end, file) {
  const startPosition = positionAt(source, start)
  const endPosition = positionAt(source, end)
  return {
    byte_end: Buffer.byteLength(source.slice(0, end), 'utf8'),
    byte_start: Buffer.byteLength(source.slice(0, start), 'utf8'),
    column: startPosition.column,
    end_column: endPosition.column,
    end_line: endPosition.line,
    file,
    line: startPosition.line,
  }
}

function positionAt(source, offset) {
  const before = source.slice(0, offset)
  const line = before.split('\n').length
  const lineStart = before.lastIndexOf('\n') + 1
  return {
    column: [...source.slice(lineStart, offset)].length + 1,
    line,
  }
}
