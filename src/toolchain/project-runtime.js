import { createHash } from 'node:crypto'

import { executeConcurrencyPlan } from './concurrency-runtime.js'
import { verifyConcurrencyTrace } from './concurrency-contract.js'

export const PROJECT_CONCURRENCY_SCHEMA = 're.project-concurrency@0.1.0'
export const PROJECT_AUDIT_SCHEMA = 're.project-concurrency-audit@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const NAME = /^[a-z][a-z0-9_.-]*$/u

export async function executeProjectConcurrency(project, options = {}) {
  try {
    const validated = validateProjectConcurrency(project)
    const result = await executeConcurrencyPlan(validated.plan, options)
    if (!result.ok) return result
    const taskIndex = new Map(validated.tasks.map((task) => [
      taskKey(task.scope_path, task.branch),
      task,
    ]))
    const trace = {
      events: result.trace.events.map((event) => {
        const scopePath = event.scope_path ?? [validated.rootRegion]
        const task = event.branch === undefined
          ? null
          : taskIndex.get(taskKey(scopePath, event.branch))
        if (event.branch !== undefined && task === undefined) {
          fail('project-task-audit-mismatch', {
            branch: event.branch,
            scope_path: scopePath,
          })
        }
        return {
          ...event,
          ...(task === null ? {} : {
            graph_revision: task.graph_revision,
            scope_path: [...task.scope_path],
            task_id: task.task_id,
          }),
        }
      }),
      region_id: result.trace.region_id,
      schema: result.trace.schema,
    }
    const scheduler = {
      ...result.scheduler,
      regions: result.scheduler.regions.map((region) => ({
        ...region,
        tasks: region.admitted.map((branch) => {
          const task = taskIndex.get(taskKey(region.scope_path, branch))
          if (task === undefined) fail('project-task-audit-mismatch', {
            branch,
            scope_path: region.scope_path,
          })
          return task.task_id
        }),
        queued_cancelled_tasks: region.queued_cancelled.map((branch) => {
          const task = taskIndex.get(taskKey(region.scope_path, branch))
          if (task === undefined) fail('project-task-audit-mismatch', {
            branch,
            scope_path: region.scope_path,
          })
          return task.task_id
        }),
      })),
    }
    const audit = {
      graph_revision: validated.graph_revision,
      scheduler,
      schema: PROJECT_AUDIT_SCHEMA,
      trace,
    }
    const verification = verifyProjectConcurrencyAudit(project, audit)
    if (!verification.ok) {
      return { diagnostics: [{ code: 'invalid-project-concurrency-audit' }], ok: false }
    }
    return { ...result, project_audit: audit, trace, verification }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'project-concurrency-failure' }],
      ok: false,
    }
  }
}

export function validateProjectConcurrency(project) {
  if (!isObject(project)) fail('invalid-project-concurrency')
  exactFields(project, ['graph_revision', 'plan', 'schema', 'tasks'], 'project-concurrency')
  if (project.schema !== PROJECT_CONCURRENCY_SCHEMA) fail('unsupported-project-concurrency')
  if (!DIGEST.test(project.graph_revision)) fail('invalid-project-graph-revision')
  if (!Array.isArray(project.tasks) || project.tasks.length === 0) {
    fail('invalid-project-task-set')
  }
  if (!isObject(project.plan)) fail('invalid-project-concurrency-plan')
  const rootRegion = rootRegionFromPlan(project.plan)
  const tasks = project.tasks.map((task) => normalizeTask(task, project.graph_revision))
  const seen = new Set()
  for (const task of tasks) {
    const key = taskKey(task.scope_path, task.branch)
    if (seen.has(key)) fail('duplicate-project-task', { branch: task.branch })
    seen.add(key)
  }
  const required = requiredTaskKeys(project.plan)
  for (const key of required) {
    if (!seen.has(key)) fail('missing-project-task', { task: key })
  }
  if (seen.size !== required.size) fail('unknown-project-task')
  validateResources(tasks)
  return { graph_revision: project.graph_revision, plan: project.plan, rootRegion, tasks }
}

export function verifyProjectConcurrencyAudit(project, audit) {
  try {
    const validated = validateProjectConcurrency(project)
    if (!isObject(audit)) fail('invalid-project-concurrency-audit')
    exactFields(audit, ['graph_revision', 'scheduler', 'schema', 'trace'], 'project-audit')
    if (audit.schema !== PROJECT_AUDIT_SCHEMA
      || audit.graph_revision !== validated.graph_revision) {
      fail('project-audit-identity-mismatch')
    }
    const taskIndex = new Map(validated.tasks.map((task) => [
      taskKey(task.scope_path, task.branch), task,
    ]))
    const events = audit.trace?.events
    if (!Array.isArray(events)) fail('invalid-project-audit-trace')
    const stripped = {
      events: events.map((event) => {
        if (event.branch === undefined) return stripProjectFields(event)
        const task = taskIndex.get(taskKey(event.scope_path, event.branch))
        if (task === undefined
          || event.task_id !== task.task_id
          || event.graph_revision !== task.graph_revision) {
          fail('project-task-audit-mismatch', { branch: event.branch })
        }
        return stripProjectFields(event)
      }),
      region_id: audit.trace.region_id,
      schema: audit.trace.schema,
    }
    return verifyConcurrencyTrace(validated.plan, stripped)
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'invalid-project-concurrency-audit' }],
      ok: false,
    }
  }
}

function normalizeTask(task, graphRevision) {
  if (!isObject(task)) fail('invalid-project-task')
  exactFields(task, ['branch', 'graph_revision', 'mutable_aliases', 'resources', 'scope_path', 'task_id'], 'project-task')
  if (!DIGEST.test(task.task_id)
    || task.graph_revision !== graphRevision
    || !DIGEST.test(task.graph_revision)) {
    fail('invalid-project-task-identity')
  }
  if (!isName(task.branch) || !Array.isArray(task.scope_path) || task.scope_path.length === 0) {
    fail('invalid-project-task-scope')
  }
  task.scope_path.forEach((segment) => {
    if (!isName(segment)) fail('invalid-project-task-scope')
  })
  if (task.task_id !== taskIdentity(graphRevision, task.scope_path, task.branch)) {
    fail('project-task-identity-mismatch', { branch: task.branch })
  }
  if (!Array.isArray(task.mutable_aliases)
    || task.mutable_aliases.some((alias) => !isName(alias))
    || new Set(task.mutable_aliases).size !== task.mutable_aliases.length) {
    fail('invalid-project-mutable-alias-set')
  }
  if (!Array.isArray(task.resources) || task.resources.length === 0) {
    fail('project-task-requires-resource-footprint')
  }
  return {
    branch: task.branch,
    graph_revision: task.graph_revision,
    mutable_aliases: [...task.mutable_aliases].sort(compareText),
    resources: task.resources.map(normalizeResource).sort(compareResource),
    scope_path: [...task.scope_path],
    task_id: task.task_id,
  }
}

function normalizeResource(resource) {
  if (!isObject(resource)) fail('invalid-project-resource')
  exactFields(resource, ['alias', 'key', 'mode'], 'project-resource')
  if (!isName(resource.alias) || !isName(resource.key)
    || !['read', 'write'].includes(resource.mode)) {
    fail('invalid-project-resource')
  }
  return { alias: resource.alias, key: resource.key, mode: resource.mode }
}

function validateResources(tasks) {
  const aliases = new Map()
  const accesses = new Map()
  for (const task of tasks) {
    for (const alias of task.mutable_aliases) {
      const previous = aliases.get(alias)
      if (previous !== undefined && previous !== task.task_id) {
        fail('mutable-resource-alias-conflict', { alias })
      }
      aliases.set(alias, task.task_id)
    }
    for (const resource of task.resources) {
      const key = resource.key
      const previous = accesses.get(key)
      if (previous !== undefined && (previous.mode === 'write' || resource.mode === 'write')) {
        fail('project-resource-conflict', { resource: key })
      }
      accesses.set(key, resource)
    }
  }
}

function requiredTaskKeys(plan) {
  if (!Array.isArray(plan.nodes)) fail('invalid-project-concurrency-plan')
  return new Set(plan.nodes
    .filter((node) => node?.kind === 'task-scope' && typeof node.id === 'string')
    .map((node) => {
      const match = node.id.match(/^par\.(.+)\.branch\.([a-z][a-z0-9_.-]*)$/u)
      if (match === null) fail('invalid-project-concurrency-plan')
      return taskKey(scopePathFromRegionKey(`par.${match[1]}`), match[2])
    }))
}

function rootRegionFromPlan(plan) {
  const output = plan?.output
  if (typeof output !== 'string' || !output.startsWith('par.') || !output.endsWith('.join')) {
    fail('invalid-project-concurrency-plan')
  }
  return output.slice('par.'.length, -'.join'.length)
}

function scopePathFromRegionKey(regionKey) {
  const parts = regionKey.split('.')
  const result = [parts[1]]
  for (let index = 2; index < parts.length; index += 4) {
    result.push(parts[index + 1], parts[index + 3])
  }
  return result
}

function taskIdentity(graphRevision, scopePath, branch) {
  return digest({ branch, graph_revision: graphRevision, scope_path: scopePath })
}

function taskKey(scopePath, branch) {
  return `${scopePath.join('\u0000')}\u0000${branch}`
}

function stripProjectFields(event) {
  const { graph_revision, task_id, scope_path, ...rest } = event
  if (scope_path !== undefined && scope_path.length > 1) {
    return { ...rest, scope_path }
  }
  return rest
}

function compareResource(left, right) {
  return compareText(`${left.key}\u0000${left.alias}\u0000${left.mode}`, `${right.key}\u0000${right.alias}\u0000${right.mode}`)
}

function compareText(left, right) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function exactFields(input, expected, label) {
  const actual = Object.keys(input).sort(compareText)
  const wanted = [...expected].sort(compareText)
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    fail(unexpectedField(actual, wanted) === null ? `missing-${label}-field` : `unexpected-${label}-field`)
  }
}

function unexpectedField(actual, wanted) {
  return actual.find((field) => !wanted.includes(field))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isName(value) {
  return typeof value === 'string' && NAME.test(value)
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}
