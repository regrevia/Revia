export class HostEnvironment {
  #instances
  #invocationObserver
  #invocationSequence

  constructor(instances, invocationObserver = null) {
    this.#instances = instances
    this.#invocationObserver = invocationObserver
    this.#invocationSequence = 0
  }

  static bind({ bindings, capabilities, onInvocation = null, registry }) {
    let invocationObserver = null
    if (onInvocation !== null) {
      let beginInvocation
      let completeInvocation
      let invalidate
      try {
        beginInvocation = onInvocation.beginInvocation
        completeInvocation = onInvocation.completeInvocation
        invalidate = onInvocation.invalidate
        if (
          typeof beginInvocation !== 'function'
          || typeof completeInvocation !== 'function'
          || typeof invalidate !== 'function'
        ) {
          throw new TypeError()
        }
        invocationObserver = Object.freeze({
          beginInvocation: Function.prototype.bind.call(beginInvocation, onInvocation),
          completeInvocation: Function.prototype.bind.call(completeInvocation, onInvocation),
          invalidate: Function.prototype.bind.call(invalidate, onInvocation),
        })
      } catch {
        return {
          diagnostics: [{ code: 'invalid-host-invocation-observer' }],
          ok: false,
        }
      }
    }
    const instances = new Map()
    const diagnostics = []
    const declaredInstances = new Map()
    for (const capability of capabilities) {
      if (
        declaredInstances.get(capability.instance) === capability.reference
      ) {
        diagnostics.push({
          code: 'duplicate-capability-instance',
          instance: capability.instance,
          reference: capability.reference,
        })
        continue
      }
      declaredInstances.set(capability.instance, capability.reference)
      const resolved = registry.resolve(capability.reference)
      if (!resolved.ok) {
        diagnostics.push({
          code: resolved.error.code,
          instance: capability.instance,
          reference: capability.reference,
        })
        continue
      }
      const matches = bindings.filter(
        (candidate) => candidate.instance === capability.instance,
      )
      if (matches.length === 0) {
        diagnostics.push({
          code: 'missing-host-binding',
          instance: capability.instance,
          reference: capability.reference,
        })
        continue
      }
      if (matches.length > 1) {
        diagnostics.push({
          code: 'ambiguous-host-binding',
          instance: capability.instance,
          reference: capability.reference,
        })
        continue
      }
      const [binding] = matches
      if (!binding.adapter.supportedInterfaces().includes(capability.reference)) {
        diagnostics.push({
          code: 'adapter-interface-mismatch',
          instance: capability.instance,
          reference: capability.reference,
        })
        continue
      }
      const metadataDiagnostics = validateAdapterResourceMetadata(
        binding.adapter,
        resolved.value,
        capability,
      )
      if (metadataDiagnostics.length > 0) {
        diagnostics.push(...metadataDiagnostics)
        continue
      }
      instances.set(capability.instance, {
        adapter: binding.adapter,
        interface: resolved.value,
        reference: capability.reference,
        registry,
      })
    }
    if (diagnostics.length > 0) {
      diagnostics.sort(compareDiagnostics)
      return { ok: false, diagnostics }
    }
    return {
      ok: true,
      value: new HostEnvironment(instances, invocationObserver),
    }
  }

  invoke(
    instance,
    member,
    typedArguments,
    invocationId,
    effectUid = invocationId,
  ) {
    const prepared = this.#prepareInvocation(
      instance,
      member,
      typedArguments,
    )
    if (!prepared.ok) return prepared.result
    const observation = this.#beginInvocation(
      prepared.bound,
      instance,
      member,
      prepared.expandedArguments,
      effectUid,
    )
    let adapterOutcome
    let response
    try {
      adapterOutcome = prepared.bound.adapter.invoke(
        { interface: prepared.bound.reference, member },
        prepared.expandedArguments,
        invocationId,
      )
    } catch {
      response = hostContractViolation({
        instance,
        invocationId,
        member,
        reason: 'adapter-panicked',
        reference: prepared.bound.reference,
      })
    }
    if (response === undefined) {
      response = this.#validateAdapterOutcome({
        adapterOutcome,
        bound: prepared.bound,
        instance,
        invocationId,
        member,
        operationSchema: prepared.operationSchema,
      })
    }
    this.#completeInvocation(observation, response)
    return response
  }

  async invokeAsync(
    instance,
    member,
    typedArguments,
    invocationId,
    effectUid = invocationId,
  ) {
    const prepared = this.#prepareInvocation(
      instance,
      member,
      typedArguments,
    )
    if (!prepared.ok) return prepared.result
    const observation = this.#beginInvocation(
      prepared.bound,
      instance,
      member,
      prepared.expandedArguments,
      effectUid,
    )
    let adapterOutcome
    let response
    try {
      adapterOutcome = await prepared.bound.adapter.invoke(
        { interface: prepared.bound.reference, member },
        prepared.expandedArguments,
        invocationId,
      )
    } catch {
      response = hostContractViolation({
        instance,
        invocationId,
        member,
        reason: 'adapter-panicked',
        reference: prepared.bound.reference,
      })
    }
    if (response === undefined) {
      response = this.#validateAdapterOutcome({
        adapterOutcome,
        bound: prepared.bound,
        instance,
        invocationId,
        member,
        operationSchema: prepared.operationSchema,
      })
    }
    this.#completeInvocation(observation, response)
    return response
  }

  #beginInvocation(bound, instance, member, arguments_, invocationId) {
    if (this.#invocationObserver === null) return null
    const sequence = this.#invocationSequence
    this.#invocationSequence += 1
    try {
      return {
        token: this.#invocationObserver.beginInvocation({
          arguments: arguments_,
          effect_uid: invocationId,
          instance,
          member,
          reference: bound.reference,
          sequence,
        }),
      }
    } catch {
      try {
        this.#invocationObserver.invalidate()
      } catch {
        // Receipt capture is diagnostic and cannot replace a host result.
      }
      return null
    }
  }

  #completeInvocation(observation, response) {
    if (observation === null) return
    try {
      this.#invocationObserver.completeInvocation(
        observation.token,
        response,
      )
    } catch {
      this.#invalidateInvocationReceipt()
    }
  }

  #invalidateInvocationReceipt() {
    try {
      this.#invocationObserver.invalidate()
    } catch {
      // Receipt capture is diagnostic and cannot replace a host result.
    }
  }

  #prepareInvocation(instance, member, typedArguments) {
    const bound = this.#instances.get(instance)
    if (bound === undefined) {
      return {
        ok: false,
        result: {
          diagnostics: [{ code: 'unknown-capability-instance', instance }],
          kind: 'check-failure',
        },
      }
    }
    const operationSchema = bound.interface.members[member]
    if (operationSchema === undefined) {
      return {
        ok: false,
        result: {
          diagnostics: [
            {
              code: 'unknown-capability-member',
              instance,
              member,
              reference: bound.reference,
            },
          ],
          kind: 'check-failure',
        },
      }
    }
    const declaredParameters = new Set(
      operationSchema.params.map((parameter) => parameter.name),
    )
    const unexpectedArguments = Object.keys(typedArguments)
      .filter((name) => !declaredParameters.has(name))
      .sort()
    if (unexpectedArguments.length > 0) {
      return {
        ok: false,
        result: {
          diagnostics: unexpectedArguments.map((parameter) => ({
            code: 'unexpected-argument',
            instance,
            member,
            parameter,
            reference: bound.reference,
          })),
          kind: 'check-failure',
        },
      }
    }
    const missingArguments = operationSchema.params.filter(
      (parameter) =>
        !Object.hasOwn(typedArguments, parameter.name) &&
        !Object.hasOwn(parameter, 'default'),
    )
    if (missingArguments.length > 0) {
      return {
        ok: false,
        result: {
          diagnostics: missingArguments.map((parameter) => ({
            code: 'missing-argument',
            instance,
            member,
            parameter: parameter.name,
            reference: bound.reference,
          })),
          kind: 'check-failure',
        },
      }
    }
    const typeMismatches = operationSchema.params.filter(
      (parameter) =>
        Object.hasOwn(typedArguments, parameter.name) &&
        !matchesType(typedArguments[parameter.name], parameter.type),
    )
    if (typeMismatches.length > 0) {
      return {
        ok: false,
        result: {
          diagnostics: typeMismatches.map((parameter) => ({
            actual: runtimeType(typedArguments[parameter.name]),
            code: 'argument-type-mismatch',
            expected: parameter.type,
            instance,
            member,
            parameter: parameter.name,
            reference: bound.reference,
          })),
          kind: 'check-failure',
        },
      }
    }
    const expandedArguments = Object.fromEntries(
      operationSchema.params.map((parameter) => [
        parameter.name,
        Object.hasOwn(typedArguments, parameter.name)
          ? typedArguments[parameter.name]
        : parameter.default,
      ]),
    )
    return { bound, expandedArguments, ok: true, operationSchema }
  }

  #validateAdapterOutcome({
    adapterOutcome,
    bound,
    instance,
    invocationId,
    member,
    operationSchema,
  }) {
    if (adapterOutcome?.kind === 'host-fault') {
      return hostContractViolation({
        instance,
        invocationId,
        member,
        reason:
          adapterOutcome.fault?.reason === 'malformed-protocol-payload'
            ? 'malformed-protocol-payload'
            : 'adapter-panicked',
        reference: bound.reference,
      })
    }
    const returnViolation = returnViolationReason(
      adapterOutcome,
      operationSchema.returns,
      bound.interface.types,
    )
    if (returnViolation !== null) {
      return hostContractViolation({
        instance,
        invocationId,
        member,
        reason: returnViolation,
        reference: bound.reference,
      })
    }
    return adapterOutcome
  }

  resourceFootprint(instance, member, typedArguments = {}) {
    const bound = this.#instances.get(instance)
    if (bound === undefined) {
      return {
        ok: false,
        error: { code: 'unknown-capability-instance', instance },
      }
    }
    return bound.registry.resourceFootprint(
      bound.reference,
      member,
      typedArguments,
    )
  }

  resourceLineage(instance, constructor) {
    const bound = this.#instances.get(instance)
    if (bound === undefined) {
      return {
        ok: false,
        error: { code: 'unknown-capability-instance', instance },
      }
    }
    return bound.registry.resourceLineage(bound.reference, constructor)
  }
}

function validateAdapterResourceMetadata(adapter, schema, capability) {
  const diagnostics = []
  if (typeof adapter.resourceCatalog === 'function' && schema.resource_catalog !== undefined) {
    const actual = adapter.resourceCatalog()
    for (const [constructor, expected] of Object.entries(schema.resource_catalog)) {
      if (!Object.hasOwn(actual ?? {}, constructor) || JSON.stringify(actual[constructor]) !== JSON.stringify(expected)) {
        diagnostics.push({
          code: 'adapter-resource-catalog-mismatch',
          constructor,
          instance: capability.instance,
          reference: capability.reference,
        })
      }
    }
  }
  if (typeof adapter.resourceParents === 'function' && schema.resource_parents !== undefined) {
    const actual = adapter.resourceParents()
    if (JSON.stringify(actual) !== JSON.stringify(schema.resource_parents)) {
      diagnostics.push({
        code: 'adapter-resource-parent-mismatch',
        instance: capability.instance,
        reference: capability.reference,
      })
    }
  }
  return diagnostics
}

function compareDiagnostics(left, right) {
  for (const field of ['instance', 'reference', 'code', 'member', 'parameter']) {
    const leftValue = left[field] ?? ''
    const rightValue = right[field] ?? ''
    const comparison = String(leftValue).localeCompare(String(rightValue))
    if (comparison !== 0) return comparison
  }
  return 0
}

function hostContractViolation({
  instance,
  invocationId,
  member,
  reason,
  reference,
}) {
  return {
    fault: {
      capability_instance: instance,
      capability_reference: reference,
      code: 'host-contract-violation',
      invocation_id: invocationId,
      member,
      phase: 'invoke',
      reason,
    },
    kind: 'host-fault',
  }
}

function matchesType(value, type) {
  if (type === 'unit') return value === null
  if (type === 'bool') return typeof value === 'boolean'
  if (type === 'int') return Number.isSafeInteger(value)
  if (type === 'bytes') return value instanceof Uint8Array
  if (type === 'text.utf8' || type === 'text.encoding' || type === 'fs.path') {
    return typeof value === 'string'
  }
  if (type.startsWith('list<') && type.endsWith('>')) {
    const elementType = type.slice(5, -1)
    return Array.isArray(value) && value.every((item) => matchesType(item, elementType))
  }
  return true
}

function returnViolationReason(outcome, returnType, types) {
  if (outcome?.kind !== 'value') return 'return-type-mismatch'
  const resultTypes = parseResultType(returnType)
  if (resultTypes === null) {
    return matchesType(outcome.value, returnType)
      ? null
      : 'return-type-mismatch'
  }
  const [okType, errorType] = resultTypes
  if (outcome.value?.kind === 'ok') {
    return matchesType(outcome.value.value, okType)
      ? null
      : 'return-type-mismatch'
  }
  if (outcome.value?.kind === 'err') {
    if (
      outcome.value.error?.type !== errorType ||
      typeof outcome.value.error?.variant !== 'string'
    ) {
      return 'return-type-mismatch'
    }
    const errorDefinition = types?.[errorType]
    if (
      errorDefinition?.kind !== 'error-sum' ||
      !errorDefinition.variants.includes(outcome.value.error.variant)
    ) {
      return 'undeclared-error-variant'
    }
    return null
  }
  return 'return-type-mismatch'
}

function parseResultType(type) {
  if (!type.startsWith('result<') || !type.endsWith('>')) return null
  const inner = type.slice(7, -1)
  let depth = 0
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]
    if (character === '<') depth += 1
    if (character === '>') depth -= 1
    if (character === ',' && depth === 0) {
      return [inner.slice(0, index).trim(), inner.slice(index + 1).trim()]
    }
  }
  return null
}

function runtimeType(value) {
  if (value === null) return 'unit'
  if (value instanceof Uint8Array) return 'bytes'
  if (Array.isArray(value)) return 'list'
  if (Number.isSafeInteger(value)) return 'int'
  if (typeof value === 'string') return 'text.utf8'
  return typeof value
}
