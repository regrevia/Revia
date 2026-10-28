import { createHash } from 'node:crypto'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const UID = /^[a-z2-7]{25}[aeimquy4]$/u
const SCHEMA = 're.fact-ledger@0.1.0'

export function buildFactLedger(project) {
  try {
    validateProject(project)
    const facts = collectFacts(project)
      .sort((left, right) => compareText(left.fact_id, right.fact_id))
    const factDigest = digest(facts)
    return {
      ok: true,
      value: {
        fact_digest: factDigest,
        facts,
        graph_revision: project.graph_revision,
        schema: SCHEMA,
      },
    }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'invalid-fact-ledger' }],
      ok: false,
    }
  }
}

function collectFacts(project) {
  const facts = [
    fact(project, 'project', ['project'], project.project_digest ?? project.graph_revision, {
      module_count: project.modules.length,
      package_digest: project.package_digest ?? null,
    }),
  ]
  if (project.package_digest !== undefined) {
    facts.push(fact(project, 'package', ['package'], null, {
      package_digest: project.package_digest,
    }))
  }
  for (const module of project.modules) {
    const modulePath = ['project', 'module', module.name]
    facts.push(fact(project, 'module', modulePath, module.uid ?? null, {
      interface_digest: module.interface_digest ?? null,
      module_surface_digest: module.module_surface_digest ?? null,
      source_sha256: module.source_sha256 ?? module.implementation_digest ?? null,
    }, module.source_sha256 ?? module.implementation_digest ?? null))
    const surface = module.surface
    for (const capability of surface?.capabilities ?? surface?.bindings ?? []) {
      const uid = capability.uid ?? capability.node_uid ?? null
      facts.push(fact(project, 'capability', [
        ...modulePath, 'capability', capability.instance ?? capability.name ?? uid,
      ], uid, capability, module.source_sha256 ?? null))
    }
    for (const error of surface?.errors ?? surface?.error_types ?? []) {
      const name = error.name ?? error.type ?? String(error)
      facts.push(fact(project, 'error', [...modulePath, 'error', name], error.uid ?? null, error, module.source_sha256 ?? null))
    }
    for (const state of module.states ?? []) {
      const name = typeof state === 'string' ? state : state.name
      facts.push(fact(project, 'state', [...modulePath, 'state', name], state.uid ?? null, state, module.source_sha256 ?? null))
    }
    for (const task of module.tasks ?? []) {
      const name = task.name ?? task.task_id
      facts.push(fact(project, 'task', [...modulePath, 'task', name], task.task_id ?? task.uid ?? null, task, module.source_sha256 ?? null))
    }
    for (const edge of module.edges ?? []) {
      const name = edge.uid ?? `${edge.from ?? ''}->${edge.to ?? ''}`
      facts.push(fact(project, 'edge', [...modulePath, 'edge', name], edge.uid ?? null, edge, module.source_sha256 ?? null))
    }
    for (const entry of module.task_contracts ?? []) {
      facts.push(fact(project, 'task-contract', [
        ...modulePath, 'task-contract', entry.name,
      ], entry.contract.node_uid, entry, module.source_sha256 ?? null))
    }
    for (const entry of module.adapter_contracts ?? []) {
      facts.push(fact(project, 'adapter-contract', [
        ...modulePath, 'adapter-contract', entry.name,
      ], entry.contract.node_uid, entry, module.source_sha256 ?? null))
    }
    for (const entry of module.run_cases ?? []) {
      facts.push(fact(project, 'run-case', [
        ...modulePath, 'run-case', entry.name,
      ], entry.request.node_uid, entry, module.source_sha256 ?? null))
    }
    for (const entry of module.type_declarations ?? []) {
      facts.push(fact(project, 'type-declaration', [
        ...modulePath, 'type', entry.name,
      ], entry.declaration_digest, entry, module.source_sha256 ?? null))
    }
    for (const entry of module.function_declarations ?? []) {
      facts.push(fact(project, 'function-declaration', [
        ...modulePath, 'function', entry.name,
      ], entry.declaration_digest, entry, module.source_sha256 ?? null))
    }
  }
  for (const agent of project.agents ?? []) {
    const agentPath = ['project', 'agent', agent.agent]
    facts.push(fact(project, 'agent', agentPath, agent.node_uid ?? agent.uid ?? null, {
      contract_digest: agent.contract_digest ?? null,
      module: agent.module,
      node_uid: agent.node_uid ?? null,
    }))
    for (const state of agent.states ?? agent.contract?.states ?? []) {
      const name = typeof state === 'string' ? state : state.name
      facts.push(fact(project, 'state', [...agentPath, 'state', name], state.uid ?? null, state))
    }
    for (const event of agent.events ?? agent.contract?.events ?? []) {
      facts.push(fact(project, 'agent-event', [...agentPath, 'event', event], null, event))
    }
    for (const transition of agent.transitions ?? agent.contract?.transitions ?? []) {
      const name = `${transition.from}:${transition.event}->${transition.to}`
      facts.push(fact(project, 'agent-transition', [...agentPath, 'transition', name], null, transition))
    }
  }
  for (const task of project.tasks ?? []) {
    const path = ['project', 'task', ...(task.scope_path ?? []), task.branch ?? task.task_id]
    facts.push(fact(project, 'task', path, task.task_id ?? task.uid ?? null, task))
  }
  for (const resource of project.resources ?? []) {
    const name = resource.alias ?? resource.key ?? resource.uid
    facts.push(fact(project, 'resource', ['project', 'resource', name], resource.uid ?? null, resource))
  }
  for (const event of project.concurrency_audit?.trace?.events ?? []) {
    if (event.task_id === undefined) continue
    facts.push(fact(project, 'concurrency-event', [
      'project', 'task', ...(event.scope_path ?? []), event.task_id, String(event.ordinal),
    ], event.task_id, event))
  }
  return facts
}

function fact(project, kind, path, uid, value, sourceSha256 = null) {
  const evidence = {
    anchor: uid ?? `path:${path.join('/')}`,
    source_sha256: sourceSha256,
  }
  return {
    evidence,
    fact_id: `fact:${path.join('/')}`,
    graph_revision: project.graph_revision,
    kind,
    path,
    source_sha256: sourceSha256,
    summary: summary(value),
    uid_anchor: uid,
    value: canonical(value),
  }
}

function validateProject(project) {
  if (!isObject(project) || !DIGEST.test(project.graph_revision)
    || !Array.isArray(project.modules)) fail('invalid-fact-ledger-project')
  for (const module of project.modules) {
    if (!isObject(module) || typeof module.name !== 'string') fail('invalid-fact-ledger-module')
    const source = module.source_sha256 ?? module.implementation_digest
    if (source !== null && source !== undefined && !DIGEST.test(source)) {
      fail('invalid-fact-ledger-source-digest', { module: module.name })
    }
  }
  for (const agent of project.agents ?? []) {
    if (!isObject(agent) || typeof agent.agent !== 'string') fail('invalid-fact-ledger-agent')
    if (agent.node_uid !== undefined && agent.node_uid !== null && !UID.test(agent.node_uid)) {
      fail('invalid-fact-ledger-agent-uid', { agent: agent.agent })
    }
  }
}

function summary(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (isObject(value)) {
    return Object.keys(value).sort(compareText).map((key) => `${key}=${display(value[key])}`).join('; ')
  }
  return display(value)
}

function display(value) {
  return typeof value === 'string' ? value : JSON.stringify(canonical(value))
}

function canonical(value, visiting = new Set()) {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, visiting))
  if (value !== null && typeof value === 'object') {
    if (visiting.has(value)) fail('cyclic-fact-value')
    visiting.add(value)
    const output = Object.fromEntries(
      Object.keys(value).sort(compareText).map((key) => [key, canonical(value[key], visiting)]),
    )
    visiting.delete(value)
    return output
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  fail('invalid-fact-value')
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
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
