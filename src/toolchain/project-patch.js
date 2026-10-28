import { createHash } from 'node:crypto'

import { buildFactLedger } from './fact-ledger.js'
import { isValidUid } from './graph-identity.js'

const PATCH_SCHEMA = 're.project-patch@0.1.0'
const RECEIPT_SCHEMA = 're.project-patch-receipt@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u

export function applyProjectPatch(project, patch, {
  check = null,
  uidFactory = deterministicUidFactory(),
} = {}) {
  try {
    validateProject(project)
    validatePatch(patch)
    if (patch.base_revision !== project.graph_revision) {
      fail('project-patch-base-revision-mismatch', {
        actual: project.graph_revision,
        expected: patch.base_revision,
      })
    }
    const draft = structuredClone(project)
    for (let index = 0; index < patch.operations.length; index += 1) {
      try {
        applyOperation(draft, patch.operations[index], uidFactory)
      } catch (error) {
        fail(error?.diagnostic?.code ?? 'project-patch-operation-failed', {
          ...(error?.diagnostic ?? {}),
          operation: index,
        })
      }
    }
    validateProject(draft)
    validateDependencies(draft)
    validateCapabilities(draft)
    if (typeof check === 'function') {
      const checked = check(draft)
      if (!checked?.ok) {
        fail('project-patch-check-failed', { diagnostics: checked?.diagnostics ?? [] })
      }
    }
    const beforeLedger = buildFactLedger(project)
    const afterLedger = buildFactLedger(draft)
    if (!beforeLedger.ok || !afterLedger.ok) fail('project-patch-fact-ledger-failed')
    const resultRevision = projectRevision(draft)
    draft.graph_revision = resultRevision
    draft.project_digest = resultRevision
    const changedFactIds = changedFacts(beforeLedger.value.facts, afterLedger.value.facts)
    return {
      ok: true,
      project: draft,
      receipt: {
        base_revision: project.graph_revision,
        changed_fact_ids: changedFactIds,
        operations: structuredClone(patch.operations),
        patch_digest: digest({
          base_revision: patch.base_revision,
          operations: patch.operations,
          result_revision: resultRevision,
        }),
        result_revision: resultRevision,
        schema: RECEIPT_SCHEMA,
      },
    }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'invalid-project-patch' }],
      ok: false,
    }
  }
}

function applyOperation(project, operation, uidFactory) {
  switch (operation.kind) {
    case 'add-module':
      addModule(project, operation, uidFactory)
      return
    case 'delete-module':
      deleteModule(project, operation)
      return
    case 'rename-module':
      renameModule(project, operation)
      return
    case 'move-module':
      moveModule(project, operation)
      return
    case 'add-symbol':
    case 'add-state':
    case 'add-task':
    case 'add-capability':
    case 'add-edge':
      addNested(project, operation, uidFactory)
      return
    case 'delete-symbol':
    case 'delete-state':
    case 'delete-task':
    case 'delete-capability':
    case 'delete-edge':
      deleteNested(project, operation)
      return
    case 'rename-symbol':
    case 'rename-state':
    case 'rename-task':
    case 'rename-capability':
      renameNested(project, operation)
      return
    default:
      fail('unsupported-project-patch-operation', { kind: operation.kind })
  }
}

function addModule(project, operation, uidFactory) {
  const module = cloneValue(operation.module)
  if (!isObject(module) || typeof module.name !== 'string') fail('invalid-project-patch-module')
  if (module.uid !== undefined) fail('project-patch-caller-uid-forbidden')
  if (project.modules.some((candidate) => candidate.name === module.name)) {
    fail('duplicate-project-module', { module: module.name })
  }
  module.uid = allocateUid(project, uidFactory)
  requireUid(module.uid)
  project.modules.push(module)
}

function deleteModule(project, operation) {
  const index = findModule(project, operation)
  project.modules.splice(index, 1)
  if (project.modules.length === 0) fail('project-must-have-module')
}

function renameModule(project, operation) {
  const module = moduleAt(project, operation)
  if (typeof operation.new_name !== 'string' || operation.new_name.length === 0) {
    fail('invalid-project-patch-name')
  }
  if (project.modules.some((candidate) => candidate.name === operation.new_name)) {
    fail('duplicate-project-module', { module: operation.new_name })
  }
  const oldName = module.name
  module.name = operation.new_name
  for (const candidate of project.modules) {
    if (!Array.isArray(candidate.dependencies)) continue
    candidate.dependencies = candidate.dependencies.map((dependency) => (
      dependency === oldName ? operation.new_name : dependency
    ))
  }
}

function moveModule(project, operation) {
  const module = moduleAt(project, operation)
  if (typeof operation.new_path !== 'string' || operation.new_path.length === 0) {
    fail('invalid-project-patch-path')
  }
  module.relative_path = operation.new_path
  module.path = operation.new_path
}

function addNested(project, operation, uidFactory) {
  const module = moduleAt(project, operation)
  const collection = nestedCollection(module, operation.kind)
  const value = cloneValue(operation.value)
  if (!isObject(value)) fail('invalid-project-patch-value')
  if (operation.kind !== 'add-task' && value.uid !== undefined) {
    fail('project-patch-caller-uid-forbidden')
  }
  if (operation.kind === 'add-task' && value.task_id !== undefined) {
    fail('project-patch-caller-uid-forbidden')
  }
  if (operation.kind !== 'add-task') value.uid = allocateUid(project, uidFactory)
  if (operation.kind === 'add-task') {
    value.task_id = allocateUid(project, uidFactory)
  } else {
    requireUid(value.uid)
  }
  const identity = value.uid ?? value.task_id
  if (collection.some((candidate) => (candidate.uid ?? candidate.task_id) === identity)) {
    fail('duplicate-project-patch-identity', { uid: identity })
  }
  collection.push(value)
}

function deleteNested(project, operation) {
  const module = moduleAt(project, operation)
  const collection = nestedCollection(module, operation.kind)
  const index = findNested(collection, operation)
  collection.splice(index, 1)
}

function renameNested(project, operation) {
  const module = moduleAt(project, operation)
  const collection = nestedCollection(module, operation.kind)
  const item = collection[findNested(collection, operation)]
  if (typeof operation.new_name !== 'string' || operation.new_name.length === 0) {
    fail('invalid-project-patch-name')
  }
  item.name = operation.new_name
}

function nestedCollection(module, kind) {
  const prefix = kind.slice(kind.indexOf('-') + 1).replace(/s$/u, '')
  const key = prefix === 'capability' ? 'capabilities' : `${prefix}s`
  module[key] ??= []
  if (!Array.isArray(module[key])) fail('invalid-project-patch-collection', { key })
  return module[key]
}

function findModule(project, operation) {
  const moduleName = operation.module
  const index = project.modules.findIndex((candidate) => candidate.name === moduleName)
  if (index < 0) fail('project-patch-module-not-found', { module: moduleName })
  const module = project.modules[index]
  checkExpectedUid(module, operation)
  return index
}

function moduleAt(project, operation) {
  return project.modules[findModule(project, operation)]
}

function findNested(collection, operation) {
  const index = collection.findIndex((candidate) => (
    (candidate.uid ?? candidate.task_id) === operation.uid
  ))
  if (index < 0) fail('project-patch-uid-not-found', { uid: operation.uid })
  checkExpectedUid(collection[index], operation)
  return index
}

function checkExpectedUid(value, operation) {
  const actual = value.uid ?? value.task_id
  if (operation.expected_uid === undefined) return
  if (operation.expected_uid !== actual) {
    fail('project-patch-uid-precondition-failed', {
      actual,
      expected: operation.expected_uid ?? null,
    })
  }
}

function validatePatch(patch) {
  if (!isObject(patch) || patch.schema !== PATCH_SCHEMA
    || !DIGEST.test(patch.base_revision)
    || !Array.isArray(patch.operations) || patch.operations.length === 0) {
    fail('invalid-project-patch')
  }
  for (const operation of patch.operations) {
    if (!isObject(operation) || typeof operation.kind !== 'string') {
      fail('invalid-project-patch-operation')
    }
    if (!operation.kind.startsWith('add-')
      && typeof operation.module !== 'string') {
      fail('project-patch-module-required')
    }
    if (operation.kind.startsWith('add-') && operation.kind !== 'add-module'
      && typeof operation.module !== 'string') {
      fail('project-patch-module-required')
    }
    if (!operation.kind.startsWith('add-') && operation.kind !== 'add-module') {
      if (!isValidUid(operation.uid ?? operation.expected_uid)) {
        fail('project-patch-affected-uid-required')
      }
    }
  }
}

function validateProject(project) {
  if (!isObject(project) || !DIGEST.test(project.graph_revision)
    || !Array.isArray(project.modules) || project.modules.length === 0) {
    fail('invalid-project-patch-project')
  }
  const names = new Set()
  const ids = new Set()
  for (const module of project.modules) {
    if (!isObject(module) || typeof module.name !== 'string') fail('invalid-project-patch-module')
    if (names.has(module.name)) fail('duplicate-project-module', { module: module.name })
    names.add(module.name)
    for (const value of valuesWithIdentity(module)) {
      if (value.uid !== undefined && !isValidUid(value.uid)) fail('invalid-project-patch-uid')
      const identity = value.uid ?? value.task_id
      if (identity !== undefined) {
        if (ids.has(identity)) fail('duplicate-project-patch-identity', { uid: identity })
        ids.add(identity)
      }
    }
  }
}

function validateDependencies(project) {
  const names = new Set(project.modules.map(({ name }) => name))
  const graph = new Map(project.modules.map((module) => [
    module.name,
    (module.dependencies ?? []).map((dependency) => {
      if (!names.has(dependency)) fail('project-patch-missing-dependency', { dependency })
      return dependency
    }),
  ]))
  const visiting = new Set()
  const visited = new Set()
  const visit = (name) => {
    if (visiting.has(name)) fail('project-patch-dependency-cycle', { module: name })
    if (visited.has(name)) return
    visiting.add(name)
    for (const dependency of graph.get(name)) visit(dependency)
    visiting.delete(name)
    visited.add(name)
  }
  for (const name of graph.keys()) visit(name)
}

function validateCapabilities(project) {
  if (!Array.isArray(project.allowed_capabilities)) return
  const allowed = new Set(project.allowed_capabilities)
  for (const module of project.modules) {
    for (const capability of module.capabilities ?? []) {
      if (capability.reference !== undefined && !allowed.has(capability.reference)) {
        fail('project-patch-capability-escalation', { reference: capability.reference })
      }
    }
  }
}

function valuesWithIdentity(value, seen = new Set()) {
  if (!isObject(value) || seen.has(value)) return []
  seen.add(value)
  const values = []
  if (value.uid !== undefined || value.task_id !== undefined) values.push(value)
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) for (const item of child) values.push(...valuesWithIdentity(item, seen))
    else values.push(...valuesWithIdentity(child, seen))
  }
  return values
}

function changedFacts(before, after) {
  const byId = new Map(after.map((fact) => [fact.fact_id, fact]))
  const changed = []
  for (const fact of before) {
    const next = byId.get(fact.fact_id)
    if (next === undefined || canonicalJson(fact) !== canonicalJson(next)) changed.push(fact.fact_id)
    byId.delete(fact.fact_id)
  }
  changed.push(...byId.keys())
  return changed.sort(compareText)
}

function projectRevision(project) {
  const copy = structuredClone(project)
  delete copy.graph_revision
  delete copy.project_digest
  return digest(copy)
}

function cloneValue(value) {
  try {
    return structuredClone(value)
  } catch {
    fail('invalid-project-patch-value')
  }
}

function nextUid(factory) {
  if (typeof factory !== 'function') fail('invalid-project-patch-uid-factory')
  return factory()
}

function allocateUid(project, factory) {
  const occupied = new Set(valuesWithIdentity(project)
    .map((value) => value.uid ?? value.task_id)
    .filter((value) => value !== undefined))
  let candidate
  do {
    candidate = nextUid(factory)
    requireUid(candidate)
  } while (occupied.has(candidate))
  return candidate
}

function requireUid(value) {
  if (!isValidUid(value)) fail('invalid-project-patch-uid', { uid: value })
}

function deterministicUidFactory() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let counter = 0
  return () => {
    let value = counter
    let prefix = ''
    for (let index = 0; index < 7; index += 1) {
      prefix = alphabet[value % alphabet.length] + prefix
      value = Math.floor(value / alphabet.length)
    }
    counter += 1
    return `${prefix}${'a'.repeat(18)}e`
  }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

function canonical(value, visiting = new Set()) {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, visiting))
  if (value !== null && typeof value === 'object') {
    if (visiting.has(value)) fail('cyclic-project-patch-value')
    visiting.add(value)
    const output = Object.fromEntries(Object.keys(value).sort(compareText)
      .map((key) => [key, canonical(value[key], visiting)]))
    visiting.delete(value)
    return output
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value))
}

function compareText(left, right) {
  return Buffer.from(String(left), 'utf8').compare(Buffer.from(String(right), 'utf8'))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}
