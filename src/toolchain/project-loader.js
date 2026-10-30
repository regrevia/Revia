import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  readdir,
  readFile,
  realpath,
} from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { validateAgentContract } from './agent-contract.js'
import { validateBusinessFunctionBinding } from './business-function-executor.js'
import { lowerControlFlow } from './control-flow-contract.js'
import {
  packageManifestDigest,
  validatePackageManifest,
} from './module-contract.js'
import { lowerValidatedModuleSurface } from './module-surface.js'
import { canonicalizeValue } from './type-contract.js'

const SCHEMA = 're.project-manifest@0.1.0'
const GRAPH_SCHEMA = 're.project-graph@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/
const UID = /^[a-z2-7]{25}[aeimquy4]$/
const CAPABILITY_REFERENCE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*@[0-9]+\.[0-9]+\.[0-9]+$/
const NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/
const PROJECT_FIELDS = [
  'agents',
  'allowed_capabilities',
  'modules',
  'package_manifest',
  'resources',
  'schema',
]
const MODULE_FIELDS = ['name', 'path', 'source_sha256']
const RESOURCE_FIELDS = ['alias', 'key', 'uid']

export async function loadProjectDirectory(rootDirectory) {
  const root = resolve(rootDirectory)
  let realRoot
  try {
    realRoot = await realpath(root)
  } catch {
    return rejected({ code: 'project-root-unreadable' })
  }
  const diagnostics = []
  const manifestPath = resolve(root, 'project.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    return rejected({
      code: error.code === 'ENOENT'
        ? 'project-manifest-missing'
        : 'project-manifest-json-invalid',
    })
  }

  validateProjectManifest(manifest, diagnostics)
  if (diagnostics.length > 0) return rejectedMany(diagnostics)

  const loaded = []
  const declaredFiles = new Set([
    'project.json',
    'README.md',
    'HANDOFF.md',
    'interface-routes.json',
  ])
  for (const entry of manifest.modules) {
    const filePath = resolve(root, entry.path)
    if (!withinRoot(root, filePath)) {
      diagnostics.push({
        code: 'project-module-path-escapes-root',
        module: entry.name,
        path: entry.path,
      })
      continue
    }
    let realFilePath
    try {
      realFilePath = await realpath(filePath)
    } catch (error) {
      diagnostics.push({
        code: error.code === 'ENOENT'
          ? 'project-module-source-missing'
          : 'project-module-source-unreadable',
        module: entry.name,
        path: entry.path,
      })
      continue
    }
    if (!withinRoot(realRoot, realFilePath)) {
      diagnostics.push({
        code: 'project-module-path-escapes-root',
        module: entry.name,
        path: entry.path,
      })
      continue
    }
    declaredFiles.add(relative(root, filePath))
    let source
    try {
      source = await readFile(realFilePath, 'utf8')
    } catch (error) {
      diagnostics.push({
        code: error.code === 'ENOENT'
          ? 'project-module-source-missing'
          : 'project-module-source-unreadable',
        module: entry.name,
        path: entry.path,
      })
      continue
    }
    const digest = sourceDigest(source)
    if (digest !== entry.source_sha256) {
      diagnostics.push({
        actual: digest,
        code: 'project-module-source-digest-mismatch',
        expected: entry.source_sha256,
        module: entry.name,
        path: entry.path,
      })
      continue
    }
    loaded.push({ entry, path: filePath, source })
  }

  for (const file of await declaredFilesUnderRoot(root)) {
    if (!declaredFiles.has(file)) {
      diagnostics.push({ code: 'unlisted-project-file', path: file })
    }
  }

  const packageResult = validatePackageManifest(manifest.package_manifest)
  if (!packageResult.ok) {
    diagnostics.push(...packageResult.diagnostics)
  }

  const projectNames = new Set(manifest.modules.map(({ name }) => name))
  const packageNames = new Set(
    Array.isArray(manifest.package_manifest.modules)
      ? manifest.package_manifest.modules.map(({ name }) => name)
      : [],
  )
  for (const name of [...projectNames].sort()) {
    if (!packageNames.has(name)) {
      diagnostics.push({ code: 'project-module-not-in-package-manifest', module: name })
    }
  }
  for (const name of [...packageNames].sort()) {
    if (!projectNames.has(name)) {
      diagnostics.push({ code: 'package-module-not-in-project-manifest', module: name })
    }
  }

  const agents = []
  const agentNames = new Set()
  for (const agent of manifest.agents ?? []) {
    const name = agent?.agent
    if (agentNames.has(name)) {
      diagnostics.push({ agent: name, code: 'duplicate-project-agent' })
      continue
    }
    agentNames.add(name)
    const result = validateAgentContract(agent)
    if (!result.ok) {
      diagnostics.push(...result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        ...(typeof name === 'string' ? { agent: name } : {}),
      })))
      continue
    }
    if (!projectNames.has(result.value.contract.module)) {
      diagnostics.push({
        agent: result.value.contract.agent,
        code: 'agent-module-not-in-project',
        module: result.value.contract.module,
      })
      continue
    }
    agents.push(result.value)
  }

  const surfaces = new Map()
  const packageModulesByName = new Map(
    manifest.package_manifest.modules.map((candidate) => [
      candidate.name,
      candidate,
    ]),
  )
  for (const { entry, path, source } of loaded) {
    const packageEntry = packageModulesByName.get(entry.name)
    if (packageEntry === undefined) {
      diagnostics.push({
        code: 'project-module-not-in-package-manifest',
        module: entry.name,
      })
      continue
    }
    if (packageEntry.implementation_digest !== entry.source_sha256) {
      diagnostics.push({
        actual: entry.source_sha256,
        code: 'project-module-implementation-digest-mismatch',
        expected: packageEntry.implementation_digest,
        module: entry.name,
      })
    }
    const surface = lowerValidatedModuleSurface(
      source,
      manifest.package_manifest,
      packageEntry,
      { file: relative(root, path) },
    )
    if (!surface.ok) {
      diagnostics.push(...surface.diagnostics)
      continue
    }
    surfaces.set(entry.name, surface.value)
  }

  const sourceAgents = [...surfaces.values()].flatMap(
    ({ agent_declarations: values = [] }) => values,
  )
  if (sourceAgents.length > 0 && (manifest.agents?.length ?? 0) > 0) {
    const manifestByName = new Map(agents.map((entry) => [entry.agent, entry]))
    const mismatch = sourceAgents.find((entry) =>
      manifestByName.get(entry.agent)?.contract_digest !== entry.contract_digest)
    if (mismatch !== undefined || sourceAgents.length !== agents.length) {
      diagnostics.push({ code: 'project-agent-authority-mismatch' })
    } else {
      agents.splice(0, agents.length, ...sourceAgents)
    }
  } else if (sourceAgents.length > 0) {
    agents.push(...sourceAgents)
  }

  if (diagnostics.length > 0) {
    return rejectedMany(diagnostics)
  }

  const ordered = topologicalOrder(manifest.package_manifest.modules)
  if (ordered === null) {
    return rejected({ code: 'module-dependency-cycle' })
  }
  const projectModulesByName = new Map(
    manifest.modules.map((candidate) => [candidate.name, candidate]),
  )
  const modules = ordered.map((name) => {
    const entry = projectModulesByName.get(name)
    const surface = surfaces.get(name)
    return {
      ...([
        're.module-surface-lowering@0.2.0',
        're.module-surface-lowering@0.3.0',
        're.module-surface-lowering@0.4.0',
      ]
        .includes(surface.schema) ? {
        edges: surface.edges,
        states: surface.states,
        tasks: surface.tasks,
      } : {}),
      ...(['re.module-surface-lowering@0.3.0', 're.module-surface-lowering@0.4.0']
        .includes(surface.schema) ? {
        adapter_contracts: surface.adapter_contracts,
        run_cases: surface.run_cases,
        task_contracts: surface.task_contracts,
      } : {}),
      ...(surface.schema === 're.module-surface-lowering@0.4.0' ? {
        agent_declarations: surface.agent_declarations,
        function_declarations: surface.function_declarations,
        type_declarations: surface.type_declarations,
      } : {}),
      implementation_digest: entry.source_sha256,
      interface_digest: surface.interface_digest,
      module_surface_digest: graphDigest(surface),
      name,
      relative_path: entry.path,
      source_sha256: entry.source_sha256,
      surface,
    }
  })
  validateSourceReviewFacts(modules, manifest.allowed_capabilities, diagnostics)
  validateSourceBusinessDeclarations(
    modules,
    agents,
    manifest.allowed_capabilities,
    manifest.resources,
    diagnostics,
  )
  validateSourceExecutionContracts(
    modules,
    agents,
    manifest.allowed_capabilities,
    manifest.resources,
    diagnostics,
  )
  if (diagnostics.length > 0) return rejectedMany(diagnostics)
  const packageDigest = packageManifestDigest(manifest.package_manifest)
  agents.sort((left, right) => compareText(left.agent, right.agent))
  const allowedCapabilities = normalizedCapabilities(manifest.allowed_capabilities)
  const resources = normalizedResources(manifest.resources)
  const projectIdentity = {
    agents,
    ...(allowedCapabilities === undefined ? {} : {
      allowed_capabilities: allowedCapabilities,
    }),
    modules,
    packageDigest,
    ...(resources === undefined ? {} : { resources }),
  }
  const project = {
    ...(allowedCapabilities === undefined ? {} : {
      allowed_capabilities: allowedCapabilities,
    }),
    agents,
    graph_revision: graphDigest(projectIdentity),
    modules,
    package_digest: packageDigest,
    package_manifest: manifest.package_manifest,
    project_digest: graphDigest(projectIdentity),
    ...(resources === undefined ? {} : { resources }),
    schema: GRAPH_SCHEMA,
  }
  return { ok: true, value: project }
}

function validateSourceBusinessDeclarations(
  modules,
  agents,
  allowedCapabilities,
  resources,
  diagnostics,
) {
  const typesByName = new Map()
  const typesByDigest = new Map()
  const functions = new Map()
  const allowed = new Set(allowedCapabilities ?? [])
  const declaredResources = resources ?? []
  for (const module of modules) {
    for (const entry of module.type_declarations ?? []) {
      if (typesByName.has(entry.name) || typesByDigest.has(entry.declaration_digest)) {
        diagnostics.push({
          code: 'duplicate-project-type-declaration',
          name: entry.name,
        })
      }
      typesByName.set(entry.name, entry)
      typesByDigest.set(entry.declaration_digest, entry)
    }
    for (const entry of module.function_declarations ?? []) {
      if (functions.has(entry.name)) {
        diagnostics.push({
          code: 'duplicate-project-function-declaration',
          name: entry.name,
        })
      }
      functions.set(entry.name, entry)
      if (entry.declaration.module !== module.name) {
        diagnostics.push({
          code: 'project-function-declaration-detached',
          name: entry.name,
        })
      }
      for (const call of entry.declaration.body.capability_calls) {
        const capability = module.surface.capabilities?.find((candidate) =>
          candidate.uid === call.node_uid
          && candidate.member === call.capability.member
          && candidate.reference === call.capability.reference)
        if (capability === undefined || !allowed.has(call.capability.reference)) {
          diagnostics.push({
            code: 'project-function-capability-not-declared',
            function: entry.name,
            call: call.id,
          })
        }
        const resource = declaredResources.find(({ alias, key }) =>
          alias === call.resource.constructor || key === call.resource.constructor)
        if (resource === undefined
          || ![`@${resource.alias}`, `@${resource.key}`].includes(
            call.capability.instance,
          )) {
          diagnostics.push({
            code: 'project-function-resource-mismatch',
            function: entry.name,
            call: call.id,
          })
        }
      }
    }
  }
  const agentNames = new Set()
  for (const agent of agents) {
    if (agentNames.has(agent.agent)) {
      diagnostics.push({ agent: agent.agent, code: 'duplicate-project-agent' })
    }
    agentNames.add(agent.agent)
  }
  for (const [name, entry] of typesByName) {
    validateDeclaredTypeReferences(
      entry.declaration,
      typesByDigest,
      diagnostics,
      { declaration: name },
    )
  }
  for (const [name, entry] of functions) {
    validateDeclaredTypeReferences(
      entry.declaration,
      typesByDigest,
      diagnostics,
      { function: name },
    )
    for (const target of entry.declaration.body.calls) {
      if (!functions.has(target)) {
        diagnostics.push({
          code: 'project-function-call-not-found',
          function: name,
          target,
        })
      }
    }
  }
  if (typesByDigest.size > 0) {
    for (const agent of agents) {
      validateDeclaredTypeReferences(
        agent.contract,
        typesByDigest,
        diagnostics,
        { agent: agent.agent },
      )
    }
  }
  if (functions.size > 0) {
    const callGraph = lowerControlFlow({
      calls: [...functions].flatMap(([from, entry]) =>
        entry.declaration.body.calls.map((to) => ({ from, to }))),
      functions: [...functions.keys()],
      kind: 'function-call-graph',
      schema: 're.control-flow-contract@0.1.0',
    })
    if (!callGraph.ok) {
      diagnostics.push({
        code: 'invalid-project-function-call-graph',
        control_flow_diagnostics: callGraph.diagnostics,
      })
    }
  }
}

function validateDeclaredTypeReferences(value, typesByDigest, diagnostics, owner) {
  const visited = new Set()
  const visit = (entry) => {
    if (entry === null || typeof entry !== 'object' || visited.has(entry)) return
    visited.add(entry)
    if (entry.kind === 'declared'
      && !typesByDigest.has(entry.declaration_digest)) {
      diagnostics.push({
        code: 'project-type-reference-not-found',
        declaration_digest: entry.declaration_digest,
        ...owner,
      })
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item)
    } else {
      for (const item of Object.values(entry)) visit(item)
    }
  }
  visit(value)
}

function validateSourceExecutionContracts(
  modules,
  agents,
  allowedCapabilities,
  resources,
  diagnostics,
) {
  const taskNames = new Set()
  const adapterNames = new Set()
  const caseNames = new Set()
  const agentNames = new Set(agents.map(({ agent }) => agent))
  const allowed = new Set(allowedCapabilities ?? [])
  const declaredResources = resources ?? []
  for (const module of modules) {
    const declaredTasks = new Map((module.tasks ?? []).map((task) => [task.name, task]))
    const contracts = new Map()
    for (const entry of module.task_contracts ?? []) {
      if (taskNames.has(entry.name)) {
        diagnostics.push({ code: 'duplicate-project-task-contract', name: entry.name })
      }
      taskNames.add(entry.name)
      const task = declaredTasks.get(entry.name)
      if (task === undefined) {
        diagnostics.push({
          code: 'project-task-contract-not-declared',
          module: module.name,
          name: entry.name,
        })
      }
      if (entry.contract.module !== module.name
        || !agentNames.has(entry.contract.agent)) {
        diagnostics.push({
          code: 'project-task-contract-detached',
          module: module.name,
          name: entry.name,
        })
      }
      contracts.set(entry.name, entry)
    }
    const adapters = new Map()
    for (const entry of module.adapter_contracts ?? []) {
      if (adapterNames.has(entry.name)) {
        diagnostics.push({ code: 'duplicate-project-adapter-contract', name: entry.name })
      }
      adapterNames.add(entry.name)
      const contract = entry.contract
      const capability = module.surface.capabilities?.find((candidate) =>
        candidate.uid === contract.node_uid
        && candidate.member === contract.capability.member
        && candidate.reference === contract.capability.reference)
      if (contract.module !== module.name
        || !agentNames.has(contract.agent)
        || capability === undefined) {
        diagnostics.push({
          code: 'project-adapter-contract-detached',
          module: module.name,
          name: entry.name,
        })
      }
      if (!allowed.has(contract.capability.reference)) {
        diagnostics.push({
          code: 'project-adapter-capability-not-allowed',
          name: entry.name,
          reference: contract.capability.reference,
        })
      }
      const resource = declaredResources.find(({ alias, key }) =>
        alias === contract.resource.constructor || key === contract.resource.constructor)
      if (resource === undefined) {
        diagnostics.push({
          code: 'project-adapter-resource-not-declared',
          name: entry.name,
          resource: contract.resource.constructor,
        })
      } else if (
        ![`@${resource.alias}`, `@${resource.key}`].includes(contract.capability.instance)
        || contract.resource.access !== contract.capability.member
      ) {
        diagnostics.push({
          code: 'project-adapter-resource-mismatch',
          name: entry.name,
          resource: contract.resource.constructor,
        })
      }
      adapters.set(entry.name, entry)
    }
    for (const entry of module.run_cases ?? []) {
      if (caseNames.has(entry.name)) {
        diagnostics.push({ code: 'duplicate-project-run-case', name: entry.name })
      }
      caseNames.add(entry.name)
      const task = contracts.get(entry.task)
      const adapter = adapters.get(entry.adapter)
      const businessFunction = module.function_declarations?.find(
        ({ name }) => name === entry.function,
      )
      if (task === undefined || adapter === undefined) {
        diagnostics.push({
          code: 'project-run-case-contract-not-found',
          module: module.name,
          name: entry.name,
        })
        continue
      }
      if (entry.function !== undefined && businessFunction === undefined) {
        diagnostics.push({
          code: 'project-run-case-function-not-found',
          module: module.name,
          name: entry.name,
        })
      }
      if (entry.request.agent !== task.contract.agent
        || entry.request.module !== module.name
        || entry.request.node_uid !== task.contract.node_uid
        || adapter.contract.agent !== task.contract.agent
        || adapter.contract.node_uid !== task.contract.node_uid) {
        diagnostics.push({
          code: 'project-run-case-identity-mismatch',
          module: module.name,
          name: entry.name,
        })
      }
      const responseKeys = new Set()
      let previousAttempt = 0
      const declarations = modules.flatMap(
        ({ type_declarations: values = [] }) =>
          values.map(({ declaration }) => declaration),
      )
      if (businessFunction !== undefined) {
        const binding = validateBusinessFunctionBinding({
          adapter_contract: adapter.contract,
          declarations,
          function_declaration: businessFunction.declaration,
        })
        if (!binding.ok) {
          diagnostics.push({
            code: binding.diagnostics[0].code
                === 'business-function-capability-type-mismatch'
              ? 'project-run-case-capability-type-mismatch'
              : 'project-run-case-business-body-unsupported',
            name: entry.name,
          })
        }
        const input = canonicalizeValue(
          businessFunction.declaration.input_type,
          entry.request.input,
          declarations,
        )
        if (!input.ok) {
          diagnostics.push({
            code: 'project-run-case-function-input-mismatch',
            name: entry.name,
          })
        }
      }
      for (const response of entry.responses) {
        const key = canonicalJson(response.input)
        if (responseKeys.has(key)) {
          diagnostics.push({
            code: 'duplicate-project-run-case-response',
            name: entry.name,
          })
        }
        responseKeys.add(key)
        const attempt = response.input.attempt
        const expectedInput = { ...entry.request.input, attempt }
        const outcome = response.outcome.value
        const validOk = outcome.kind === 'ok'
          && Object.keys(outcome).sort(compareText).join(',') === 'kind,value'
        const validError = outcome.kind === 'err'
          && Object.keys(outcome).sort(compareText).join(',') === 'error,kind'
          && plainObject(outcome.error)
          && Object.keys(outcome.error).sort(compareText).join(',') === 'type,variant'
          && outcome.error.type === adapter.contract.error_type.name
          && adapter.contract.error_variants.includes(outcome.error.variant)
        const businessValue = businessFunction === undefined
          ? { ok: true }
          : canonicalizeValue(
            outcome.kind === 'ok'
              ? businessFunction.declaration.output_type
              : businessFunction.declaration.error_type,
            outcome.kind === 'ok' ? outcome.value : outcome.error,
            declarations,
          )
        if (!Number.isSafeInteger(attempt)
          || attempt <= previousAttempt
          || attempt > task.contract.max_attempts
          || canonicalJson(response.input) !== canonicalJson(expectedInput)
          || (!validOk && !validError)
          || !businessValue.ok) {
          diagnostics.push({
            code: 'project-run-case-response-contract-mismatch',
            name: entry.name,
          })
        }
        if (Number.isSafeInteger(attempt)) previousAttempt = attempt
      }
    }
  }
}

function validateProjectManifest(manifest, diagnostics) {
  if (!plainObject(manifest) || manifest.schema !== SCHEMA) {
    diagnostics.push({ code: 'unsupported-project-manifest' })
    return
  }
  unknownFields(manifest, PROJECT_FIELDS, diagnostics, 'unexpected-project-manifest-field')
  const modules = manifest.modules
  if (!Array.isArray(modules) || modules.length === 0) {
    diagnostics.push({ code: 'invalid-project-module-set' })
    return
  }
  if (
    Object.hasOwn(manifest, 'agents') &&
    (!Array.isArray(manifest.agents) || manifest.agents.length === 0)
  ) {
    diagnostics.push({ code: 'invalid-project-agent-set' })
  }
  validateAllowedCapabilities(manifest.allowed_capabilities, diagnostics)
  validateResources(manifest.resources, diagnostics)
  const names = new Set()
  for (const entry of modules) {
    if (!plainObject(entry)) {
      diagnostics.push({ code: 'invalid-project-module-entry' })
      continue
    }
    unknownFields(entry, MODULE_FIELDS, diagnostics, 'unexpected-project-module-field')
    if (!NAME.test(entry.name)) diagnostics.push({ code: 'invalid-project-module-name', module: entry.name })
    if (names.has(entry.name)) diagnostics.push({ code: 'duplicate-project-module', module: entry.name })
    names.add(entry.name)
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      diagnostics.push({ code: 'invalid-project-module-path', module: entry.name })
    }
    if (!DIGEST.test(entry.source_sha256)) {
      diagnostics.push({ code: 'invalid-project-module-source-digest', module: entry.name })
    }
  }
  if (!plainObject(manifest.package_manifest)) {
    diagnostics.push({ code: 'missing-project-package-manifest' })
  }
}

function validateAllowedCapabilities(value, diagnostics) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    diagnostics.push({ code: 'invalid-project-allowed-capabilities' })
    return
  }
  const seen = new Set()
  for (const reference of value) {
    if (typeof reference !== 'string' || !CAPABILITY_REFERENCE.test(reference)) {
      diagnostics.push({ code: 'invalid-project-allowed-capability' })
    } else if (seen.has(reference)) {
      diagnostics.push({ code: 'duplicate-project-allowed-capability', reference })
    }
    seen.add(reference)
  }
}

function validateResources(value, diagnostics) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    diagnostics.push({ code: 'invalid-project-resource-set' })
    return
  }
  const aliases = new Set()
  const keys = new Set()
  const uids = new Set()
  for (const resource of value) {
    if (!plainObject(resource)
      || Object.keys(resource).sort().join(',') !== RESOURCE_FIELDS.join(',')
      || !NAME.test(resource.alias)
      || !NAME.test(resource.key)
      || !UID.test(resource.uid)) {
      diagnostics.push({ code: 'invalid-project-resource' })
      continue
    }
    if (aliases.has(resource.alias)
      || keys.has(resource.key)
      || uids.has(resource.uid)) {
      diagnostics.push({ code: 'duplicate-project-resource' })
    }
    aliases.add(resource.alias)
    keys.add(resource.key)
    uids.add(resource.uid)
  }
}

function validateSourceReviewFacts(modules, allowedCapabilities, diagnostics) {
  const allowed = new Set(allowedCapabilities ?? [])
  const uids = new Set()
  const taskIds = new Set()
  for (const module of modules) {
    for (const capability of module.surface.capabilities ?? []) {
      if (!allowed.has(capability.reference)) {
        diagnostics.push({
          code: 'project-module-capability-not-allowed',
          module: module.name,
          reference: capability.reference,
        })
      }
    }
    for (const value of [
      ...(module.surface.capabilities ?? []),
      ...(module.surface.errors ?? []),
      ...(module.states ?? []),
      ...(module.edges ?? []),
    ]) {
      if (uids.has(value.uid)) {
        diagnostics.push({ code: 'duplicate-project-review-uid', uid: value.uid })
      }
      uids.add(value.uid)
    }
    for (const task of module.tasks ?? []) {
      if (taskIds.has(task.task_id)) {
        diagnostics.push({
          code: 'duplicate-project-task-id',
          task_id: task.task_id,
        })
      }
      taskIds.add(task.task_id)
    }
  }
}

function normalizedCapabilities(value) {
  return value === undefined ? undefined : [...value].sort(compareText)
}

function normalizedResources(value) {
  return value === undefined
    ? undefined
    : structuredClone(value).sort((left, right) => compareText(left.alias, right.alias))
}

function topologicalOrder(packageModules) {
  const entries = new Map(packageModules.map((entry) => [entry.name, entry]))
  const indegree = new Map([...entries.keys()].map((name) => [name, 0]))
  const dependents = new Map([...entries.keys()].map((name) => [name, []]))
  for (const entry of packageModules) {
    for (const dependency of entry.interface?.dependencies ?? []) {
      if (dependency.scope !== 'package' || !entries.has(dependency.module)) continue
      indegree.set(entry.name, indegree.get(entry.name) + 1)
      dependents.get(dependency.module).push(entry.name)
    }
  }
  const ready = [...indegree].filter(([, value]) => value === 0).map(([name]) => name)
  heapify(ready)
  const order = []
  while (ready.length > 0) {
    const name = heapPop(ready)
    order.push(name)
    for (const dependent of dependents.get(name).sort(compareText)) {
      indegree.set(dependent, indegree.get(dependent) - 1)
      if (indegree.get(dependent) === 0) heapPush(ready, dependent)
    }
  }
  return order.length === entries.size ? order : null
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

async function declaredFilesUnderRoot(root) {
  const result = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else result.push(relative(root, path))
    }
  }
  await visit(root)
  return result
}

function withinRoot(root, path) {
  const value = relative(root, path)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function unknownFields(value, expected, diagnostics, code) {
  for (const field of Object.keys(value).sort()) {
    if (!expected.includes(field)) diagnostics.push({ code, field })
  }
}

function sourceDigest(source) {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`
}

function graphDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rejected(diagnostic) {
  return { diagnostics: [diagnostic], ok: false }
}

function rejectedMany(diagnostics) {
  return { diagnostics, ok: false }
}
