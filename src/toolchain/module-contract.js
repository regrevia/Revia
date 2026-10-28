import { createHash } from 'node:crypto'

const DIGEST = /^sha256:[0-9a-f]{64}$/
const SEMANTIC_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/
const BINDING = /^[a-z][a-z0-9_]*$/
const EXPORT_KINDS = new Set(['function', 'type', 'value'])

export function moduleInterfaceDigest(moduleInterface) {
  return digest(normalizeModuleInterface(moduleInterface))
}

export function packageManifestDigest(manifest) {
  return digest(normalizePackageManifest(manifest))
}

export function validatePackageManifest(manifest) {
  const diagnostics = []
  if (!plainObject(manifest) || manifest.schema !== 're.package-manifest@0.1.0') {
    return rejected({ code: 'unsupported-package-manifest' })
  }
  recordUnknownFields(manifest, [
    'external_interfaces',
    'modules',
    'package',
    'schema',
  ], diagnostics, { code: 'unexpected-package-manifest-field' })
  if (!SEMANTIC_NAME.test(manifest.package)) {
    diagnostics.push({ code: 'invalid-package-name', package: manifest.package })
  }

  const modules = indexed(manifest.modules, ({ name }) => name)
  if (!modules.ok) {
    diagnostics.push({ code: 'invalid-module-set' })
  }
  const externalInterfaces = indexed(
    manifest.external_interfaces,
    externalKey,
  )
  if (!externalInterfaces.ok) {
    diagnostics.push({ code: 'invalid-external-interface-set' })
  }

  if (modules.ok) {
    for (const moduleEntry of modules.values.values()) {
      validateModuleEntry(moduleEntry, diagnostics)
    }
  }
  if (externalInterfaces.ok) {
    for (const external of externalInterfaces.values.values()) {
      validateExternalInterface(external, diagnostics)
    }
  }
  if (modules.ok && externalInterfaces.ok) {
    validateDependencies(modules.values, externalInterfaces.values, diagnostics)
    validateModuleDag(modules.values, diagnostics)
  }
  return result(diagnostics)
}

export function resolveModuleImport(manifest, fromModule, binding, exportName) {
  const validation = validatePackageManifest(manifest)
  if (!validation.ok) return validation
  const moduleEntry = manifest.modules.find(({ name }) => name === fromModule)
  if (moduleEntry === undefined) {
    return rejected({ code: 'module-not-found', module: fromModule })
  }
  const dependency = moduleEntry.interface.dependencies.find(
    (candidate) => candidate.binding === binding,
  )
  if (dependency === undefined) {
    return rejected({ binding, code: 'module-binding-not-found', module: fromModule })
  }
  const target = dependency.scope === 'package'
    ? manifest.modules.find(({ name }) => name === dependency.module)
    : manifest.external_interfaces.find(
      (candidate) =>
        candidate.module === dependency.module &&
        candidate.package_digest === dependency.package_digest,
    )
  const exported = target.interface.exports.find(({ name }) => name === exportName)
  if (exported === undefined) {
    return rejected({
      binding,
      code: 'module-export-not-found',
      export: exportName,
      module: dependency.module,
    })
  }
  return {
    ok: true,
    reference: {
      binding,
      contract_digest: exported.contract_digest,
      interface_digest: dependency.interface_digest,
      kind: exported.kind,
      module: dependency.module,
      name: exported.name,
      ...(dependency.scope === 'external'
        ? { package_digest: dependency.package_digest }
        : {}),
    },
  }
}

export function planModuleRecheck(manifest, changes) {
  const validation = validatePackageManifest(manifest)
  if (!validation.ok) return validation
  if (!plainObject(changes)) {
    return rejected({ code: 'invalid-module-change-set' })
  }
  const diagnostics = []
  recordUnknownFields(changes, [
    'implementation_changed',
    'interface_changed',
  ], diagnostics, { code: 'unexpected-module-change-field' })
  const implementationChanged = uniqueNames(
    changes.implementation_changed,
    'implementation-change',
    diagnostics,
  )
  const interfaceChanged = uniqueNames(
    changes.interface_changed,
    'interface-change',
    diagnostics,
  )
  const known = new Set(manifest.modules.map(({ name }) => name))
  for (const name of [...implementationChanged, ...interfaceChanged]) {
    if (!known.has(name)) diagnostics.push({ code: 'changed-module-not-found', module: name })
  }
  if (diagnostics.length > 0) return result(diagnostics)

  const selected = new Set([...implementationChanged, ...interfaceChanged])
  const reverse = reverseDependencies(manifest.modules)
  const queue = [...interfaceChanged]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const dependent of reverse.get(current) ?? []) {
      if (!selected.has(dependent)) {
        selected.add(dependent)
        queue.push(dependent)
      }
    }
  }
  return {
    modules: topologicalModuleOrder(manifest.modules).filter((name) => selected.has(name)),
    ok: true,
  }
}

function validateModuleEntry(entry, diagnostics) {
  if (!plainObject(entry)) {
    diagnostics.push({ code: 'invalid-module-entry' })
    return
  }
  recordUnknownFields(entry, [
    'implementation_digest',
    'interface',
    'interface_digest',
    'name',
  ], diagnostics, { code: 'unexpected-module-entry-field', module: entry.name })
  if (!SEMANTIC_NAME.test(entry.name)) {
    diagnostics.push({ code: 'invalid-module-name', module: entry.name })
  }
  if (!DIGEST.test(entry.implementation_digest)) {
    diagnostics.push({ code: 'invalid-module-implementation-digest', module: entry.name })
  }
  validateModuleInterface(entry.interface, diagnostics, entry.name)
  if (entry.interface?.module !== entry.name) {
    diagnostics.push({ code: 'module-interface-name-mismatch', module: entry.name })
  }
  if (!DIGEST.test(entry.interface_digest)) {
    diagnostics.push({ code: 'invalid-module-interface-digest', module: entry.name })
  } else {
    const actualDigest = safeModuleInterfaceDigest(entry.interface)
    if (actualDigest === null) {
      diagnostics.push({ code: 'module-interface-not-canonicalizable', module: entry.name })
    } else if (entry.interface_digest !== actualDigest) {
      diagnostics.push({ code: 'module-interface-digest-mismatch', module: entry.name })
    }
  }
}

function validateExternalInterface(entry, diagnostics) {
  if (!plainObject(entry)) {
    diagnostics.push({ code: 'invalid-external-interface' })
    return
  }
  recordUnknownFields(entry, [
    'interface',
    'interface_digest',
    'module',
    'package_digest',
  ], diagnostics, { code: 'unexpected-external-interface-field', module: entry.module })
  if (!SEMANTIC_NAME.test(entry.module)) {
    diagnostics.push({ code: 'invalid-external-module-name', module: entry.module })
  }
  if (!DIGEST.test(entry.package_digest)) {
    diagnostics.push({ code: 'invalid-external-package-digest', module: entry.module })
  }
  validateModuleInterface(entry.interface, diagnostics, entry.module)
  if (entry.interface?.module !== entry.module) {
    diagnostics.push({ code: 'external-interface-name-mismatch', module: entry.module })
  }
  if (!DIGEST.test(entry.interface_digest)) {
    diagnostics.push({ code: 'invalid-external-interface-digest', module: entry.module })
  } else {
    const actualDigest = safeModuleInterfaceDigest(entry.interface)
    if (actualDigest === null) {
      diagnostics.push({ code: 'external-interface-not-canonicalizable', module: entry.module })
    } else if (entry.interface_digest !== actualDigest) {
      diagnostics.push({ code: 'external-interface-digest-mismatch', module: entry.module })
    }
  }
}

function validateModuleInterface(moduleInterface, diagnostics, moduleName) {
  if (!plainObject(moduleInterface) || moduleInterface.schema !== 're.module-interface@0.1.0') {
    diagnostics.push({ code: 'unsupported-module-interface', module: moduleName })
    return
  }
  recordUnknownFields(moduleInterface, [
    'dependencies',
    'exports',
    'module',
    'schema',
  ], diagnostics, { code: 'unexpected-module-interface-field', module: moduleName })
  if (!SEMANTIC_NAME.test(moduleInterface.module)) {
    diagnostics.push({ code: 'invalid-module-interface-name', module: moduleName })
  }
  const exports = indexed(moduleInterface.exports, ({ name }) => name)
  if (!exports.ok) {
    diagnostics.push({ code: 'invalid-module-export-set', module: moduleName })
  } else {
    for (const exported of exports.values.values()) {
      if (!plainObject(exported)) continue
      recordUnknownFields(exported, [
        'contract_digest',
        'kind',
        'name',
      ], diagnostics, { code: 'unexpected-module-export-field', module: moduleName })
      if (!BINDING.test(exported.name)) {
        diagnostics.push({ code: 'invalid-module-export-name', export: exported.name, module: moduleName })
      }
      if (!EXPORT_KINDS.has(exported.kind)) {
        diagnostics.push({ code: 'invalid-module-export-kind', export: exported.name, module: moduleName })
      }
      if (!DIGEST.test(exported.contract_digest)) {
        diagnostics.push({ code: 'invalid-export-contract-digest', export: exported.name, module: moduleName })
      }
    }
  }
  const dependencies = indexed(moduleInterface.dependencies, ({ binding }) => binding)
  if (!dependencies.ok) {
    diagnostics.push({ code: 'invalid-module-dependency-set', module: moduleName })
  } else {
    for (const dependency of dependencies.values.values()) {
      validateDependencyShape(dependency, diagnostics, moduleName)
    }
  }
}

function validateDependencyShape(dependency, diagnostics, moduleName) {
  if (!plainObject(dependency)) return
  const fields = dependency.scope === 'external'
    ? ['binding', 'interface_digest', 'module', 'package_digest', 'scope']
    : ['binding', 'interface_digest', 'module', 'scope']
  recordUnknownFields(dependency, fields, diagnostics, {
    binding: dependency.binding,
    code: 'unexpected-module-dependency-field',
    module: moduleName,
  })
  if (!BINDING.test(dependency.binding)) {
    diagnostics.push({ code: 'invalid-module-binding', module: moduleName })
  }
  if (!SEMANTIC_NAME.test(dependency.module)) {
    diagnostics.push({ code: 'invalid-dependency-module-name', module: moduleName })
  }
  if (!['external', 'package'].includes(dependency.scope)) {
    diagnostics.push({ code: 'invalid-module-dependency-scope', module: moduleName })
  }
  if (!DIGEST.test(dependency.interface_digest)) {
    diagnostics.push({ code: 'invalid-dependency-interface-digest', module: moduleName })
  }
  if (dependency.scope === 'external' && !DIGEST.test(dependency.package_digest)) {
    diagnostics.push({ code: 'invalid-dependency-package-digest', module: moduleName })
  }
}

function validateDependencies(modules, externalInterfaces, diagnostics) {
  for (const [moduleName, moduleEntry] of modules) {
    for (const dependency of dependenciesOf(moduleEntry)) {
      if (dependency.scope === 'package') {
        const target = modules.get(dependency.module)
        if (target === undefined) {
          diagnostics.push({ code: 'package-dependency-not-found', module: moduleName, target: dependency.module })
        } else if (dependency.interface_digest !== target.interface_digest) {
          diagnostics.push({ code: 'package-dependency-interface-mismatch', module: moduleName, target: dependency.module })
        }
      } else if (dependency.scope === 'external') {
        const target = externalInterfaces.get(externalKey(dependency))
        if (target === undefined) {
          diagnostics.push({ code: 'external-dependency-not-found', module: moduleName, target: dependency.module })
        } else if (dependency.interface_digest !== target.interface_digest) {
          diagnostics.push({ code: 'external-dependency-interface-mismatch', module: moduleName, target: dependency.module })
        }
      }
    }
  }
}

function validateModuleDag(modules, diagnostics) {
  const order = topologicalModuleOrder([...modules.values()])
  if (order.length !== modules.size) diagnostics.push({ code: 'module-dependency-cycle' })
}

function topologicalModuleOrder(modules) {
  const byName = new Map(modules.map((entry) => [entry.name, entry]))
  const remaining = new Map([...byName.keys()].map((name) => [name, 0]))
  const reverse = reverseDependencies(modules)
  for (const entry of modules) {
    for (const dependency of dependenciesOf(entry)) {
      if (dependency.scope === 'package' && byName.has(dependency.module)) {
        remaining.set(entry.name, remaining.get(entry.name) + 1)
      }
    }
  }
  const ready = [...remaining]
    .filter(([, count]) => count === 0)
    .map(([name]) => name)
  heapify(ready)
  const order = []
  while (ready.length > 0) {
    const name = heapPop(ready)
    order.push(name)
    for (const dependent of reverse.get(name) ?? []) {
      const count = remaining.get(dependent) - 1
      remaining.set(dependent, count)
      if (count === 0) heapPush(ready, dependent)
    }
  }
  return order
}

function heapify(values) {
  for (let index = Math.floor(values.length / 2) - 1; index >= 0; index -= 1) {
    heapDown(values, index)
  }
}

function heapPush(values, value) {
  values.push(value)
  let index = values.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (compareText(values[parent], value) <= 0) break
    values[index] = values[parent]
    index = parent
  }
  values[index] = value
}

function heapPop(values) {
  const first = values[0]
  const last = values.pop()
  if (values.length > 0) {
    values[0] = last
    heapDown(values, 0)
  }
  return first
}

function heapDown(values, start) {
  let index = start
  const value = values[index]
  while (true) {
    const left = index * 2 + 1
    if (left >= values.length) break
    const right = left + 1
    let child = left
    if (right < values.length && compareText(values[right], values[left]) < 0) {
      child = right
    }
    if (compareText(values[child], value) >= 0) break
    values[index] = values[child]
    index = child
  }
  values[index] = value
}

function reverseDependencies(modules) {
  const reverse = new Map(modules.map(({ name }) => [name, []]))
  for (const entry of modules) {
    for (const dependency of dependenciesOf(entry)) {
      if (dependency.scope === 'package' && reverse.has(dependency.module)) {
        reverse.get(dependency.module).push(entry.name)
      }
    }
  }
  for (const values of reverse.values()) values.sort()
  return reverse
}

function uniqueNames(values, prefix, diagnostics) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    diagnostics.push({ code: `invalid-${prefix}-set` })
    return []
  }
  const unique = new Set(values)
  if (unique.size !== values.length) diagnostics.push({ code: `duplicate-${prefix}` })
  return [...unique].sort()
}

function dependenciesOf(entry) {
  return Array.isArray(entry?.interface?.dependencies)
    ? entry.interface.dependencies
    : []
}

function safeModuleInterfaceDigest(moduleInterface) {
  try {
    return moduleInterfaceDigest(moduleInterface)
  } catch {
    return null
  }
}

function normalizePackageManifest(manifest) {
  if (!plainObject(manifest)) return manifest
  return {
    ...manifest,
    external_interfaces: [...(manifest.external_interfaces ?? [])]
      .map((entry) => ({
        ...entry,
        interface: normalizeModuleInterface(entry.interface),
      }))
      .sort((left, right) => compareText(externalKey(left), externalKey(right))),
    modules: [...(manifest.modules ?? [])]
      .map((entry) => ({
        ...entry,
        interface: normalizeModuleInterface(entry.interface),
      }))
      .sort((left, right) => compareText(left.name, right.name)),
  }
}

function normalizeModuleInterface(moduleInterface) {
  if (!plainObject(moduleInterface)) return moduleInterface
  return {
    ...moduleInterface,
    dependencies: [...(moduleInterface.dependencies ?? [])]
      .sort((left, right) => compareText(left.binding, right.binding)),
    exports: [...(moduleInterface.exports ?? [])]
      .sort((left, right) => compareText(left.name, right.name)),
  }
}

function externalKey(entry) {
  return `${entry?.package_digest ?? ''}\0${entry?.module ?? ''}`
}

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function indexed(values, idOf) {
  if (!Array.isArray(values)) return { ok: false }
  const result = new Map()
  for (const value of values) {
    if (!plainObject(value)) return { ok: false }
    const id = idOf(value)
    if (typeof id !== 'string' || result.has(id)) return { ok: false }
    result.set(id, value)
  }
  return { ok: true, values: result }
}

function recordUnknownFields(value, expected, diagnostics, context) {
  if (!plainObject(value)) return
  for (const field of Object.keys(value).sort()) {
    if (!expected.includes(field)) diagnostics.push({ ...context, field })
  }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rejected(diagnostic) {
  return { diagnostics: [diagnostic], ok: false }
}

function result(diagnostics) {
  return diagnostics.length === 0
    ? { ok: true }
    : { diagnostics, ok: false }
}
