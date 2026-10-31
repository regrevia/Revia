import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

import { snapshotUint8Array } from './uint8-array.js'

export const RUNTIME_EFFECT_RECEIPT_SCHEMA = 're.runtime-effect-receipt@0.1.0'
const DEMAND_SCHEMA = 're.runtime-effect-demand@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const RECEIPT_FIELDS = [
  'graph_revision',
  'observations',
  'receipt_digest',
  'schema',
]
const OBSERVATION_FIELDS = [
  'arguments',
  'demand_id',
  'effect_uid',
  'instance',
  'member',
  'occurrence',
  'receipt_id',
  'reference',
  'response',
  'sequence',
]

export function createRuntimeEffectReceiptRecorder(graphRevision) {
  if (!DIGEST.test(graphRevision)) {
    throw new TypeError('runtime effect receipt requires a graph revision')
  }
  const occurrences = new Map()
  const observations = []
  let valid = true

  return Object.freeze({
    invalidate() {
      valid = false
    },

    beginInvocation(event) {
      if (event === null
        || typeof event !== 'object'
        || !Number.isSafeInteger(event.sequence)
        || event.sequence < 0
        || typeof event.effect_uid !== 'string'
        || typeof event.instance !== 'string'
        || typeof event.reference !== 'string'
        || typeof event.member !== 'string') {
        throw new TypeError('invalid runtime effect observation')
      }
      const arguments_ = snapshotObservationValue(event.arguments)
      const demand = {
        arguments: arguments_,
        instance: event.instance,
        member: event.member,
        reference: event.reference,
        schema: DEMAND_SCHEMA,
      }
      const demandKey = canonicalJson(demand)
      const occurrence = occurrences.get(demandKey) ?? 0
      occurrences.set(demandKey, occurrence + 1)
      const demandId = digest({ ...demand, occurrence })
      const token = observations.length
      observations.push({
        arguments: arguments_,
        demand_id: demandId,
        effect_uid: event.effect_uid,
        instance: event.instance,
        member: event.member,
        occurrence,
        receipt_id: null,
        reference: event.reference,
        response: null,
        sequence: event.sequence,
      })
      return token
    },

    completeInvocation(token, inputResponse) {
      if (!Number.isSafeInteger(token) || token < 0 || token >= observations.length) {
        throw new TypeError('invalid runtime effect observation token')
      }
      const previous = observations[token]
      if (previous.response !== null) {
        throw new TypeError('runtime effect observation already completed')
      }
      const response = snapshotObservationValue(inputResponse)
      previous.response = response
      previous.receipt_id = digest({
        demand_id: previous.demand_id,
        response,
        schema: RUNTIME_EFFECT_RECEIPT_SCHEMA,
      })
    },

    toReceipt() {
      if (!valid || observations.length === 0) return null
      if (observations.some(({ receipt_id: receiptId }) => receiptId === null)) return null
      return {
        graph_revision: graphRevision,
        observations: observations
          .slice()
          .sort((left, right) => left.sequence - right.sequence)
          .map((observation) => structuredClone(observation)),
        schema: RUNTIME_EFFECT_RECEIPT_SCHEMA,
        receipt_digest: digest({
          graph_revision: graphRevision,
          observations: observations
            .slice()
            .sort((left, right) => left.sequence - right.sequence)
            .map((observation) => structuredClone(observation)),
          schema: RUNTIME_EFFECT_RECEIPT_SCHEMA,
        }),
      }
    },
  })
}

export function verifyRuntimeEffectReceipt(receipt, options = {}) {
  try {
    const candidate = snapshotObservationValue(receipt)
    if (!plainObject(candidate)
      || !exactFields(candidate, RECEIPT_FIELDS)
      || candidate.schema !== RUNTIME_EFFECT_RECEIPT_SCHEMA
      || !DIGEST.test(candidate.graph_revision)
      || !DIGEST.test(candidate.receipt_digest)
      || !Array.isArray(candidate.observations)
      || candidate.observations.length === 0) {
      return invalid('runtime-effect-receipt-invalid')
    }
    if (
      options.graphRevision !== undefined
      && options.graphRevision !== candidate.graph_revision
    ) {
      return invalid('runtime-effect-receipt-graph-revision-mismatch')
    }

    const { receipt_digest: receiptDigest, ...content } = candidate
    if (digest(content) !== receiptDigest) {
      return invalid('runtime-effect-receipt-digest-mismatch')
    }
    const occurrences = new Map()
    for (let index = 0; index < candidate.observations.length; index += 1) {
      const observation = candidate.observations[index]
      if (!plainObject(observation)
        || !exactFields(observation, OBSERVATION_FIELDS)
        || observation.sequence !== index
        || !Number.isSafeInteger(observation.occurrence)
        || observation.occurrence < 0
        || !DIGEST.test(observation.demand_id)
        || !DIGEST.test(observation.receipt_id)
        || typeof observation.effect_uid !== 'string'
        || typeof observation.instance !== 'string'
        || typeof observation.reference !== 'string'
        || typeof observation.member !== 'string') {
        return invalid('runtime-effect-receipt-observation-invalid', {
          sequence: index,
        })
      }

      const arguments_ = snapshotObservationValue(observation.arguments)
      const response = snapshotObservationValue(observation.response)
      if (!canonicalEqual(arguments_, observation.arguments)
        || !canonicalEqual(response, observation.response)) {
        return invalid('runtime-effect-receipt-observation-noncanonical', {
          sequence: index,
        })
      }
      const demand = {
        arguments: arguments_,
        instance: observation.instance,
        member: observation.member,
        reference: observation.reference,
        schema: DEMAND_SCHEMA,
      }
      const demandKey = canonicalJson(demand)
      const expectedOccurrence = occurrences.get(demandKey) ?? 0
      if (observation.occurrence !== expectedOccurrence
        || observation.demand_id !== digest({
          ...demand,
          occurrence: expectedOccurrence,
        })) {
        return invalid('runtime-effect-receipt-demand-mismatch', {
          sequence: index,
        })
      }
      occurrences.set(demandKey, expectedOccurrence + 1)
      if (observation.receipt_id !== digest({
        demand_id: observation.demand_id,
        response,
        schema: RUNTIME_EFFECT_RECEIPT_SCHEMA,
      })) {
        return invalid('runtime-effect-receipt-response-mismatch', {
          sequence: index,
        })
      }
    }
    return { ok: true }
  } catch {
    return invalid('runtime-effect-receipt-invalid')
  }
}

function snapshotObservationValue(value, ancestors = new Set()) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value
  }
  const bytes = snapshotUint8Array(value)
  if (bytes !== null) {
    return {
      hex: Buffer.from(bytes).toString('hex'),
      kind: 'bytes',
    }
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('runtime effect observation is not canonical JSON data')
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const length = value.length
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new TypeError('runtime effect observation array is invalid')
      }
      const keys = Reflect.ownKeys(value)
      if (keys.length !== length + 1
        || keys.some((key) => key !== 'length'
          && (typeof key !== 'string'
            || !/^(?:0|[1-9][0-9]*)$/u.test(key)
            || Number(key) >= length))) {
        throw new TypeError('runtime effect observation array has extra fields')
      }
      const result = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined
          || !descriptor.enumerable
          || !('value' in descriptor)) {
          throw new TypeError('runtime effect observation array is sparse or accessor-backed')
        }
        result.push(snapshotObservationValue(descriptor.value, ancestors))
      }
      return result
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('runtime effect observation object is not plain')
    }
    const result = {}
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string')) {
      throw new TypeError('runtime effect observation has symbol keys')
    }
    for (const key of keys.sort(compareUtf8)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)) {
        throw new TypeError('runtime effect observation contains a non-data field')
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: snapshotObservationValue(descriptor.value, ancestors),
        writable: true,
      })
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

function exactFields(value, expected) {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string')) return false
  const actual = ownKeys.sort(compareUtf8)
  const wanted = [...expected].sort(compareUtf8)
  return actual.length === wanted.length
    && actual.every((field, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field)
      return field === wanted[index]
        && descriptor?.enumerable === true
        && 'value' in descriptor
    })
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function invalid(code, details = {}) {
  return { code, ...details, ok: false }
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value), 'utf8')
    .digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareUtf8).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}
