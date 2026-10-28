import { createHash } from 'node:crypto'

import { graphRevision } from './structured-patch.js'
import { minimalStdPackageIdentityForGraph } from './minimal-std-subset.js'

const INDEX_SCHEMA = 're.project-review-index@0.1.0'
const FACT_SCHEMA = 're.project-review-fact@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/

export function buildReviewManifest(graph, { moduleInterfaceDigest = null } = {}) {
  const main = graph.functions.find((candidate) => candidate.name === '@main')
  const capabilities = graph.capabilities.map((capability) => ({
    instance: capability.instance,
    reference: capability.reference,
    uid: capability.uid,
  }))
  const effects = []
  const errorPaths = []

  for (const statement of main?.statements ?? []) {
    if (statement.kind === 'let') {
      const call = statement.value
      const argument = call.arguments[0]
      const parameters = call.arguments
        .map((candidate) => ({
          endpoint: candidate.source?.endpoint ?? null,
          name: parameterName(call, candidate),
        }))
        .sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0
        )
      const effect = {
        call_uid: call.uid,
        kind: call.target.kind === 'capability-member' ? 'capability-member-call' : 'pure-operation-call',
        member: call.target.kind === 'capability-member' ? call.target.member : call.target.operation,
        parameter: parameters.length <= 1 ? parameterName(call, argument) : null,
        parameter_endpoint:
          parameters.length <= 1 ? argument?.source?.endpoint ?? null : null,
        schema_reference:
          call.target.kind === 'capability-member'
            ? call.target.schemaReference
            : call.target.schemaReference,
      }
      if (parameters.length > 1) effect.parameters = parameters
      effects.push(effect)
    }
    if (statement.kind === 'return') {
      for (const branch of statement.value.branches) {
        errorPaths.push({
          branch_uid: branch.uid,
          consumer_uid: statement.uid,
          error_type: branch.variant,
          producer_uid: statement.value.input.producer,
        })
      }
    }
  }

  const manifest = {
    capabilities,
    effects,
    error_paths: errorPaths,
    graph_revision: graphRevision(graph),
    module: graph.unit,
    schema: 're.review-manifest@0.1.0',
    uid_anchors: collectUidAnchors(graph),
  }
  if (moduleInterfaceDigest !== null) {
    manifest.module_interface_digest = moduleInterfaceDigest
  }
  const std = minimalStdPackageIdentityForGraph(graph)
  if (std.ok && std.value.modules.length > 0) {
    manifest.std_capability_digest = std.value.capability_digest
    manifest.std_modules = std.value.modules
    manifest.std_package_digest = std.value.package_digest
    manifest.std_runtime_package_digest = std.value.runtime_package_digest
  }
  return manifest
}

function parameterName(call, argument) {
  if (argument === undefined) return null
  if (argument.name !== null && argument.name !== undefined) return argument.name
  for (const [name, binding] of Object.entries(call.typedArguments ?? {})) {
    if (binding.endpoint === argument.source?.endpoint) return name
  }
  return null
}

export function buildProjectReviewIndex(manifest, {
  changedSince = null,
  cursor = null,
  limit = 50,
} = {}) {
  try {
    validateIndexManifest(manifest)
    const indexRevision = reviewIndexRevision(manifest)
    const entries = projectReviewEntries(manifest)
    const filtered = changedSince === null
      ? entries
      : entries.filter((entry) => entry.index_revision !== changedSince)
    const start = cursor === null ? 0 : decodeCursor(cursor, filtered.length)
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return { diagnostics: [{ code: 'invalid-review-index-limit', limit }], ok: false }
    }
    const page = filtered.slice(start, start + limit)
    return {
      ok: true,
      value: {
        entries: page,
        graph_revision: manifest.graph_revision,
        index_revision: indexRevision,
        module_interface_digest: manifest.module_interface_digest,
        next_cursor: start + limit < filtered.length ? encodeCursor(start + limit) : null,
        schema: INDEX_SCHEMA,
      },
    }
  } catch (error) {
    return { diagnostics: [error?.diagnostic ?? { code: 'invalid-review-index' }], ok: false }
  }
}

export function expandProjectReviewFact(manifest, {
  factId,
  indexRevision,
} = {}) {
  try {
    validateIndexManifest(manifest)
    const actualRevision = reviewIndexRevision(manifest)
    if (indexRevision !== actualRevision) {
      throw diagnostic('review-index-revision-mismatch', {
        actual: actualRevision,
        expected: indexRevision ?? null,
      })
    }
    if (typeof factId !== 'string' || !factId.startsWith('fact:')) {
      throw diagnostic('invalid-review-fact-id', { fact_id: factId ?? null })
    }
    const matches = projectReviewEntries(manifest)
      .filter(({ fact_id: candidate }) => candidate === factId)
    if (matches.length === 0) {
      throw diagnostic('review-fact-not-found', { fact_id: factId })
    }
    if (matches.length > 1) {
      throw diagnostic('duplicate-review-fact-id', { fact_id: factId })
    }
    return {
      ok: true,
      value: {
        detail: factDetail(manifest, matches[0]),
        fact: matches[0],
        index_revision: actualRevision,
        schema: FACT_SCHEMA,
      },
    }
  } catch (error) {
    return { diagnostics: [error?.diagnostic ?? { code: 'invalid-review-fact' }], ok: false }
  }
}

function projectReviewEntries(manifest) {
  const module = manifest.module
  const entries = [
    factEntry(manifest, ['project', module], moduleUidAnchor(manifest), 'module', module),
  ]
  for (const capability of manifest.capabilities) {
    entries.push(factEntry(
      manifest,
      ['project', module, 'capability', capability.instance],
      capability.uid,
      'capability',
      capability.reference,
    ))
  }
  for (const effect of manifest.effects) {
    entries.push(factEntry(
      manifest,
      ['project', module, 'effect', effect.call_uid],
      effect.call_uid,
      'effect',
      `${effect.schema_reference}#${effect.member}`,
    ))
  }
  for (const path of manifest.error_paths) {
    entries.push(factEntry(
      manifest,
      ['project', module, 'error-path', path.branch_uid],
      path.branch_uid,
      'error_path',
      path.error_type,
    ))
  }
  return entries.sort((left, right) => left.fact_id.localeCompare(right.fact_id))
}

function factDetail(manifest, fact) {
  if (fact.kind === 'module') {
    return {
      capability_count: manifest.capabilities.length,
      effect_count: manifest.effects.length,
      error_path_count: manifest.error_paths.length,
    }
  }
  if (fact.kind === 'capability') {
    return structuredClone(
      manifest.capabilities.find(({ uid }) => uid === fact.uid_anchor),
    )
  }
  if (fact.kind === 'effect') {
    return structuredClone(
      manifest.effects.find(({ call_uid: uid }) => uid === fact.uid_anchor),
    )
  }
  if (fact.kind === 'error_path') {
    return structuredClone(
      manifest.error_paths.find(({ branch_uid: uid }) => uid === fact.uid_anchor),
    )
  }
  throw diagnostic('unsupported-review-fact-kind', { kind: fact.kind })
}

function moduleUidAnchor(manifest) {
  const capabilityUids = new Set(manifest.capabilities.map(({ uid }) => uid))
  const anchor = manifest.uid_anchors.find((uid) => !capabilityUids.has(uid))
  if (anchor === undefined) throw diagnostic('review-index-module-anchor-not-found')
  return anchor
}

function factEntry(manifest, path, uid, kind, summary) {
  return {
    fact_id: `fact:${path.join('/')}`,
    graph_revision: manifest.graph_revision,
    index_revision: reviewIndexRevision(manifest),
    kind,
    module: manifest.module,
    module_interface_digest: manifest.module_interface_digest,
    path,
    summary,
    uid_anchor: uid,
  }
}

function validateIndexManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw diagnostic('invalid-review-index-manifest')
  }
  if (!DIGEST.test(manifest.graph_revision)) {
    throw diagnostic('invalid-review-index-graph-revision')
  }
  if (!DIGEST.test(manifest.module_interface_digest)) {
    throw diagnostic('review-index-module-interface-digest-required')
  }
}

function reviewIndexRevision(manifest) {
  return `sha256:${createHash('sha256')
    .update(`${manifest.graph_revision}\0${manifest.module_interface_digest}`)
    .digest('hex')}`
}

function encodeCursor(offset) {
  return `offset:${offset}`
}

function decodeCursor(cursor, length) {
  if (typeof cursor !== 'string' || !cursor.startsWith('offset:')) {
    throw diagnostic('invalid-review-index-cursor', { cursor })
  }
  const offset = Number(cursor.slice('offset:'.length))
  if (!Number.isInteger(offset) || offset < 0 || offset > length) {
    throw diagnostic('invalid-review-index-cursor', { cursor })
  }
  return offset
}

function diagnostic(code, details = {}) {
  const error = new TypeError(code)
  error.diagnostic = { code, ...details }
  return error
}

function collectUidAnchors(graph) {
  const anchors = []
  for (const capability of graph.capabilities) anchors.push(capability.uid)
  for (const function_ of graph.functions) {
    anchors.push(function_.uid)
    for (const literal of function_.literals ?? []) anchors.push(literal.uid)
    for (const statement of function_.statements ?? []) {
      anchors.push(statement.uid)
      if (statement.kind === 'return') {
        anchors.push(statement.value.uid)
        for (const branch of statement.value.branches ?? []) anchors.push(branch.uid)
      }
      if (statement.kind === 'let') anchors.push(statement.value.uid)
    }
  }
  return anchors
}
