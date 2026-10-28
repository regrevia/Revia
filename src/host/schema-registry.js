import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

const RESOURCE_NAME = /^[a-z][a-z0-9_.-]*$/
const DIGEST = /^sha256:[0-9a-f]{64}$/u

export class SchemaRegistry {
  #definitions

  constructor(definitions) {
    this.#definitions = definitions
  }

  static load(definitions) {
    const indexed = new Map()
    const diagnostics = []
    for (const definition of definitions) {
      const reference = referenceOf(definition)
      const validationDiagnostics = validateDefinition(definition, reference)
      if (validationDiagnostics.length > 0) {
        diagnostics.push(...validationDiagnostics)
        continue
      }
      const bytes = canonicalBytes(definition)
      const existing = indexed.get(reference)
      if (existing !== undefined && existing.bytes !== bytes) {
        diagnostics.push({ code: 'schema-revision-conflict', reference })
        continue
      }
      if (existing === undefined) {
        indexed.set(reference, {
          bytes,
          digest: digestOf(bytes),
          definition: deepFreeze(structuredClone(definition)),
        })
      }
    }
    if (diagnostics.length > 0) {
      diagnostics.sort((left, right) =>
        left.reference.localeCompare(right.reference),
      )
      return { ok: false, diagnostics }
    }
    return { ok: true, value: new SchemaRegistry(indexed) }
  }

  resolve(reference, { contentDigest = null } = {}) {
    const entry = this.#definitions.get(reference)
    if (entry === undefined) {
      return {
        ok: false,
        error: { code: 'missing-schema-revision', reference },
      }
    }
    if (contentDigest !== null && contentDigest !== entry.digest) {
      return {
        ok: false,
        error: {
          actual: entry.digest,
          code: 'schema-content-digest-mismatch',
          expected: contentDigest,
          reference,
        },
      }
    }
    return { ok: true, value: entry.definition }
  }

  contentDigest(reference) {
    const entry = this.#definitions.get(reference)
    if (entry === undefined) {
      return {
        ok: false,
        error: { code: 'missing-schema-revision', reference },
      }
    }
    return { ok: true, value: entry.digest }
  }

  resourceFootprint(reference, memberName, typedArguments = {}) {
    const entry = this.#definitions.get(reference)
    if (entry === undefined) {
      return {
        ok: false,
        error: { code: 'missing-schema-revision', reference },
      }
    }
    const member = entry.definition.members[memberName]
    if (member === undefined) {
      return {
        ok: false,
        error: {
          code: 'missing-schema-member',
          member: memberName,
          reference,
        },
      }
    }
    if (
      typedArguments === null
      || typeof typedArguments !== 'object'
      || Array.isArray(typedArguments)
    ) {
      return {
        ok: false,
        error: {
          code: 'invalid-resource-footprint-arguments',
          member: memberName,
          reference,
        },
      }
    }
    const missingArguments = member.params.filter(
      (parameter) =>
        !Object.hasOwn(typedArguments, parameter.name)
        && !Object.hasOwn(parameter, 'default'),
    )
    if (missingArguments.length > 0) {
      return {
        ok: false,
        error: {
          code: 'missing-resource-footprint-argument',
          member: memberName,
          parameter: missingArguments[0].name,
          reference,
        },
      }
    }
    const expanded = Object.fromEntries(
      member.params.map((parameter) => [
        parameter.name,
        Object.hasOwn(typedArguments, parameter.name)
          ? typedArguments[parameter.name]
          : parameter.default,
      ]),
    )
    const accesses = []
    for (const access of member.access) {
      const parsed = parseResourceAccess(access)
      const constructor = entry.definition.resource_aliases?.[parsed.constructor]
        ?? parsed.constructor
      const declaration = entry.definition.resource_catalog?.[constructor]
      if (declaration === undefined) {
        return {
          ok: false,
          error: {
            code: 'resource-constructor-not-declared',
            constructor,
            member: memberName,
            reference,
          },
        }
      }
      let segments = []
      let unknown = false
      for (const segment of declaration.segments) {
        const value = expanded[segment.parameter]
        const encoded = canonicalResourceBytes(value)
        if (encoded === null) {
          unknown = true
          break
        }
        segments.push({
          canonical_hex: encoded.toString('hex'),
          type_digest: segment.type_digest,
        })
      }
      accesses.push({
        handle: null,
        mode: parsed.mode,
        resource: {
          domain_digest: declaration.domain_digest,
          segments: unknown ? null : segments,
        },
      })
    }
    return { ok: true, value: accesses }
  }

  resourceLineage(reference, constructor) {
    const entry = this.#definitions.get(reference)
    if (entry === undefined) {
      return {
        ok: false,
        error: { code: 'missing-schema-revision', reference },
      }
    }
    const canonical = entry.definition.resource_aliases?.[constructor] ?? constructor
    if (!entry.definition.resource_catalog?.[canonical]) {
      return {
        ok: false,
        error: {
          code: 'resource-constructor-not-declared',
          constructor: canonical,
          reference,
        },
      }
    }
    const lineage = []
    const parents = entry.definition.resource_parents ?? {}
    let current = canonical
    while (current !== undefined) {
      lineage.push(current)
      current = parents[current]
    }
    return { ok: true, value: lineage }
  }
}

function referenceOf(definition) {
  return `${definition.identity}@${definition.revision}`
}

function validateDefinition(definition, reference) {
  const diagnostics = []
  const resourceAliases = validateResourceAliases(
    definition.resource_aliases,
    reference,
    diagnostics,
  )
  validateResourceParents(
    definition.resource_parents,
    resourceAliases,
    reference,
    diagnostics,
  )
  validateResourceCatalog(definition.resource_catalog, definition, reference, diagnostics)
  validateResourceParentCatalogs(definition, reference, diagnostics)
  validateResourceCatalogBindings(definition, resourceAliases, reference, diagnostics)
  for (const [typeName, typeDefinition] of Object.entries(
    definition.types ?? {},
  ).sort()) {
    if (typeDefinition.kind !== 'error-sum') continue
    if (!Array.isArray(typeDefinition.variants)) {
      diagnostics.push({
        code: 'invalid-schema-definition',
        reason: 'invalid-error-sum-variants',
        reference,
        type: typeName,
      })
      continue
    }
    if (typeDefinition.variants.length === 0) {
      diagnostics.push({
        code: 'invalid-schema-definition',
        reason: 'empty-error-sum',
        reference,
        type: typeName,
      })
    }
    const seenVariants = new Set()
    for (const variant of typeDefinition.variants) {
      if (seenVariants.has(variant)) {
        diagnostics.push({
          code: 'invalid-schema-definition',
          reason: 'duplicate-error-variant',
          reference,
          type: typeName,
          variant,
        })
      }
      seenVariants.add(variant)
    }
  }
  for (const [memberName, member] of Object.entries(definition.members).sort()) {
    const parameterNames = new Set(member.params.map(({ name }) => name))
    for (const access of member.access) {
      const match = /^((?:read|write)) ([a-z][a-z0-9_.-]*)(?:\(([^()]*)\))?$/.exec(access)
      if (match === null) {
        diagnostics.push({
          code: 'invalid-schema-definition',
          member: memberName,
          reason: 'invalid-resource-access-expression',
          reference,
        })
        continue
      }
      const parameters = match[3] === undefined || match[3] === ''
        ? []
        : match[3].split(',').map((parameter) => parameter.trim())
      if (parameters.some((parameter) => parameter === '')) {
        diagnostics.push({
          code: 'invalid-schema-definition',
          member: memberName,
          reason: 'invalid-resource-access-expression',
          reference,
        })
        continue
      }
      for (const parameter of parameters) {
        if (!parameterNames.has(parameter)) {
          diagnostics.push({
            code: 'invalid-schema-definition',
            member: memberName,
            parameter,
            reason: 'unknown-resource-access-parameter',
            reference,
          })
        }
      }
    }
    if (
      member.cancellation !== undefined &&
      !['cooperative', 'complete-before-join'].includes(member.cancellation)
    ) {
      diagnostics.push({
        code: 'invalid-schema-definition',
        member: memberName,
        reason: 'invalid-cancellation-contract',
        reference,
      })
    }
    const primaryCount = member.params.filter(
      (parameter) => parameter.primary === true,
    ).length
    if (primaryCount > 1) {
      diagnostics.push({
        code: 'invalid-schema-definition',
        member: memberName,
        reason: 'multiple-primary-parameters',
        reference,
      })
    }
    const errorType = resultErrorType(member.returns)
    if (
      errorType !== null &&
      definition.types?.[errorType]?.kind !== 'error-sum'
    ) {
      diagnostics.push({
        code: 'invalid-schema-definition',
        member: memberName,
        reason: 'missing-error-type-definition',
        reference,
        type: errorType,
      })
    }
  }
  return diagnostics
}

function validateResourceParentCatalogs(definition, reference, diagnostics) {
  if (definition.resource_catalog === undefined || definition.resource_parents === undefined) {
    return
  }
  for (const [child, parent] of Object.entries(definition.resource_parents)) {
    if (!Object.hasOwn(definition.resource_catalog, child)) {
      diagnostics.push({
        child,
        code: 'invalid-schema-definition',
        reason: 'resource-parent-constructor-not-declared',
        reference,
      })
    }
    if (!Object.hasOwn(definition.resource_catalog, parent)) {
      diagnostics.push({
        parent,
        code: 'invalid-schema-definition',
        reason: 'resource-parent-constructor-not-declared',
        reference,
      })
    }
  }
}

function validateResourceCatalogBindings(definition, resourceAliases, reference, diagnostics) {
  if (definition.resource_catalog === undefined) return
  for (const [memberName, member] of Object.entries(definition.members).sort()) {
    for (const access of member.access) {
      const parsed = parseResourceAccess(access)
      const constructor = resourceAliases[parsed.constructor] ?? parsed.constructor
      const declaration = definition.resource_catalog[constructor]
      if (declaration === undefined) continue
      const declared = new Set(parsed.parameters)
      const catalog = new Set(declaration.segments.map(({ parameter }) => parameter))
      if (
        declared.size !== catalog.size
        || [...declared].some((parameter) => !catalog.has(parameter))
      ) {
        diagnostics.push({
          code: 'invalid-schema-definition',
          constructor,
          member: memberName,
          reason: 'resource-access-catalog-parameter-mismatch',
          reference,
        })
      }
      for (const parameter of catalog) {
        if (!member.params.some(({ name }) => name === parameter)) {
          diagnostics.push({
            code: 'invalid-schema-definition',
            constructor,
            member: memberName,
            parameter,
            reason: 'unknown-resource-access-parameter',
            reference,
          })
        }
      }
    }
  }
}

function validateResourceCatalog(value, definition, reference, diagnostics) {
  if (value === undefined) return
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push({
      code: 'invalid-schema-definition',
      reason: 'invalid-resource-catalog',
      reference,
    })
    return
  }
  for (const [constructor, declaration] of Object.entries(value).sort(([left], [right]) =>
    compareUtf8(left, right),
  )) {
    if (!RESOURCE_NAME.test(constructor)) {
      diagnostics.push({
        code: 'invalid-schema-definition',
        constructor,
        reason: 'invalid-resource-catalog-name',
        reference,
      })
      continue
    }
    if (
      declaration === null
      || typeof declaration !== 'object'
      || Array.isArray(declaration)
      || !DIGEST.test(declaration.domain_digest)
      || !Array.isArray(declaration.segments)
    ) {
      diagnostics.push({
        code: 'invalid-schema-definition',
        constructor,
        reason: 'invalid-resource-catalog-entry',
        reference,
      })
      continue
    }
    const seenParameters = new Set()
    for (const segment of declaration.segments) {
      if (
        segment === null
        || typeof segment !== 'object'
        || Array.isArray(segment)
        || typeof segment.parameter !== 'string'
        || !DIGEST.test(segment.type_digest)
        || !RESOURCE_NAME.test(segment.parameter)
      ) {
        diagnostics.push({
          code: 'invalid-schema-definition',
          constructor,
          reason: 'invalid-resource-catalog-segment',
          reference,
        })
        continue
      }
      if (seenParameters.has(segment.parameter)) {
        diagnostics.push({
          code: 'invalid-schema-definition',
          constructor,
          parameter: segment.parameter,
          reason: 'duplicate-resource-catalog-parameter',
          reference,
        })
      }
      seenParameters.add(segment.parameter)
      if (
        !Object.values(definition.members).some((member) =>
          member.params.some(({ name }) => name === segment.parameter),
        )
      ) {
        diagnostics.push({
          code: 'invalid-schema-definition',
          constructor,
          parameter: segment.parameter,
          reason: 'unknown-resource-catalog-parameter',
          reference,
        })
      }
    }
  }
}

function validateResourceAliases(value, reference, diagnostics) {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push({
      code: 'invalid-schema-definition',
      reason: 'invalid-resource-alias-table',
      reference,
    })
    return {}
  }
  const aliases = {}
  for (const [alias, target] of Object.entries(value).sort(([left], [right]) =>
    compareUtf8(left, right),
  )) {
    if (!RESOURCE_NAME.test(alias) || typeof target !== 'string' || !RESOURCE_NAME.test(target)) {
      diagnostics.push({
        alias,
        code: 'invalid-schema-definition',
        reason: 'invalid-resource-alias-name',
        reference,
      })
      continue
    }
    if (alias === target) {
      diagnostics.push({
        alias,
        code: 'invalid-schema-definition',
        reason: 'resource-alias-self-reference',
        reference,
        target,
      })
      continue
    }
    aliases[alias] = target
  }
  for (const [alias, target] of Object.entries(aliases)) {
    if (Object.hasOwn(aliases, target)) {
      diagnostics.push({
        alias,
        code: 'invalid-schema-definition',
        reason: 'resource-alias-chaining-not-allowed',
        reference,
        target,
      })
    }
  }
  return aliases
}

function validateResourceParents(value, resourceAliases, reference, diagnostics) {
  if (value === undefined) return
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push({
      code: 'invalid-schema-definition',
      reason: 'invalid-resource-parent-table',
      reference,
    })
    return
  }
  const parents = {}
  for (const [child, parent] of Object.entries(value).sort(([left], [right]) =>
    compareUtf8(left, right),
  )) {
    if (!RESOURCE_NAME.test(child) || typeof parent !== 'string' || !RESOURCE_NAME.test(parent)) {
      diagnostics.push({
        child,
        code: 'invalid-schema-definition',
        reason: 'invalid-resource-parent-name',
        reference,
      })
      continue
    }
    if (Object.hasOwn(resourceAliases, child) || Object.hasOwn(resourceAliases, parent)) {
      diagnostics.push({
        child,
        code: 'invalid-schema-definition',
        parent,
        reason: 'resource-parent-must-use-canonical-name',
        reference,
      })
      continue
    }
    if (child === parent) {
      diagnostics.push({
        child,
        code: 'invalid-schema-definition',
        reason: 'resource-parent-self-reference',
        reference,
      })
      continue
    }
    parents[child] = parent
  }
  const reported = new Set()
  for (const child of Object.keys(parents).sort(compareUtf8)) {
    const path = []
    const positions = new Map()
    let current = child
    while (Object.hasOwn(parents, current)) {
      if (positions.has(current)) {
        const cycle = path.slice(positions.get(current)).sort(compareUtf8)
        const key = cycle.join('\u0000')
        if (!reported.has(key)) {
          diagnostics.push({
            children: cycle,
            code: 'invalid-schema-definition',
            reason: 'resource-parent-cycle',
            reference,
          })
          reported.add(key)
        }
        break
      }
      positions.set(current, path.length)
      path.push(current)
      current = parents[current]
    }
  }
}

function resultErrorType(type) {
  if (!type.startsWith('result<') || !type.endsWith('>')) return null
  const inner = type.slice(7, -1)
  let depth = 0
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]
    if (character === '<') depth += 1
    if (character === '>') depth -= 1
    if (character === ',' && depth === 0) {
      return inner.slice(index + 1).trim()
    }
  }
  return null
}

function canonicalBytes(value) {
  return JSON.stringify(canonicalValue(normalizeDefinition(value)))
}

function digestOf(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function normalizeDefinition(definition) {
  const resourceAliases = definition.resource_aliases ?? {}
  const { resource_aliases: _resourceAliases, ...semanticDefinition } = definition
  return {
    ...semanticDefinition,
    types: Object.fromEntries(
      Object.entries(definition.types ?? {}).map(([typeName, typeDefinition]) => [
        typeName,
        typeDefinition.kind === 'error-sum'
          ? {
              ...typeDefinition,
              variants: [...typeDefinition.variants].sort(compareUtf8),
            }
          : typeDefinition,
      ]),
    ),
    members: Object.fromEntries(
      Object.entries(definition.members).map(([memberName, member]) => [
        memberName,
        {
          ...member,
          access: member.access
            .map((access) => normalizeAccessExpressionWithAliases(
              access,
              resourceAliases,
            ))
            .sort(compareUtf8),
          params: [...member.params].sort((left, right) =>
            compareUtf8(left.name, right.name),
          ),
        },
      ]),
    ),
  }
}

function normalizeAccessExpressionWithAliases(access, resourceAliases) {
  const match = /^((?:read|write)) ([a-z][a-z0-9_.-]*)(?:\(([^()]*)\))?$/.exec(access)
  if (match === null) return access
  const parameters = match[3] === undefined || match[3] === ''
    ? []
    : match[3].split(',').map((parameter) => parameter.trim())
  const constructor = resourceAliases[match[2]] ?? match[2]
  return `${match[1]} ${constructor}${
    parameters.length === 0 ? '' : `(${parameters.join(',')})`
  }`
}

function parseResourceAccess(access) {
  const match = /^((?:read|write)) ([a-z][a-z0-9_.-]*)(?:\(([^()]*)\))?$/.exec(access)
  const parameters = match[3] === undefined || match[3] === ''
    ? []
    : match[3].split(',').map((parameter) => parameter.trim())
  return {
    constructor: match[2],
    mode: match[1],
    parameters,
  }
}

function canonicalResourceBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'boolean') return Buffer.from([value ? 1 : 0])
  if (Number.isSafeInteger(value)) return Buffer.from(String(value), 'utf8')
  return null
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUtf8)
        .map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
  }
  return value
}
