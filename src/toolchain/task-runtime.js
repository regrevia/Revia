import {
  checkpointDigest,
  normalizeTaskCheckpoint,
  taskIdentity,
  validateTaskContract,
} from './task-contract.js'

const RUNTIME_OPTIONS = [
  'cancel_at',
  'checkpoint',
  'clearTimeoutImpl',
  'effects',
  'perform',
  'resource',
  'setTimeoutImpl',
  'signal',
  'timeout_ms',
]

export async function executeTask(contractInput, request, options = {}) {
  try {
    const contractResult = validateTaskContract(contractInput)
    if (!contractResult.ok) return contractResult
    const identityResult = taskIdentity(contractInput, request)
    if (!identityResult.ok) return identityResult
    assertOptions(options)
    const contract = contractResult.value
    const identity = identityResult.value
    const effects = options.effects instanceof Map ? options.effects : fail('invalid-task-effects')
    if (typeof options.perform !== 'function') fail('invalid-task-performer')
    const trace = []
    const lifecycle = createLifecycle(options)
    const run = async () => {
      await lifecycle.start()
      const cancelAt = options.cancel_at ?? null
      if (!['before_start', 'after_start', null].includes(cancelAt)) {
        fail('invalid-task-cancellation')
      }
      let checkpoint = null
      if (options.checkpoint !== undefined && options.checkpoint !== null) {
        const normalized = normalizeTaskCheckpoint(options.checkpoint)
        if (!normalized.ok) return normalized
        checkpoint = normalized.value
        if (checkpoint.task_id !== identity.task_id
          || checkpoint.revision !== identity.revision
          || checkpoint.input_digest !== identity.input_digest) {
          fail('stale-task-checkpoint')
        }
        if (checkpoint.attempt > contract.max_attempts) fail('task-checkpoint-attempt-limit')
        validateCheckpointData(checkpoint.data, contract)
      }
      const replay = [...effects.values()].find((effect) => effect.task_id === identity.task_id)
      if (replay !== undefined) {
        return await finalize(result('succeeded', identity, {
          attempts: replay.attempt,
          effect_key: replay.effect_key,
          output: replay.output,
          replayed: true,
          trace: [{ kind: 'replay', task_id: identity.task_id }],
        }), lifecycle)
      }
      if (lifecycle.reason !== null || cancelAt === 'before_start') {
        return await finalize(result('cancelled', identity, {
          attempts: checkpoint?.attempt ?? 0,
          cancel_reason: lifecycle.reason ?? 'before_start',
          replayed: false,
          trace: [{ kind: 'cancel-before-start', task_id: identity.task_id }],
        }), lifecycle)
      }
      let attempt = checkpoint?.attempt ?? 0
      while (attempt < contract.max_attempts) {
        attempt += 1
        trace.push({
          attempt,
          backoff_ms: attempt === 1 ? 0 : contract.backoff_ms[attempt - 2],
          kind: 'attempt-start',
        })
        const outcome = await options.perform({
          attempt,
          checkpoint: checkpoint ? { ...checkpoint } : null,
          input: request.input,
          signal: lifecycle.controller.signal,
          task_id: identity.task_id,
        })
        validateOutcome(outcome)
        if (lifecycle.reason !== null
          || (cancelAt === 'after_start' && outcome.effect === null)) {
          return await finalize(result('cancelled', identity, {
            attempts: attempt,
            cancel_reason: lifecycle.reason ?? 'after_start',
            replayed: false,
            trace: [...trace, { attempt, kind: 'cancel-after-start' }],
          }), lifecycle)
        }
        if (outcome.kind === 'success') {
          const committed = commitEffect(effects, identity, attempt, outcome)
          return await finalize(result('succeeded', identity, {
            attempts: attempt,
            effect_key: committed.effect_key,
            output: outcome.output,
            replayed: committed.replayed,
            trace: [...trace, { attempt, effect_key: committed.effect_key, kind: 'success' }],
          }), lifecycle, {
            rollback: committed.replayed
              ? null
              : () => effects.delete(committed.effect_key),
          })
        }
        trace.push({ attempt, error: outcome.error, kind: 'attempt-error' })
        if (!contract.retryable_errors.includes(outcome.error.code)
          || attempt >= contract.max_attempts) {
          return await finalize(result('failed', identity, {
            attempts: attempt,
            error: outcome.error,
            replayed: false,
            trace: [...trace],
          }), lifecycle)
        }
        checkpoint = {
          attempt,
          data: outcome.checkpoint,
          input_digest: identity.input_digest,
          revision: identity.revision,
          state: 'retrying',
          task_id: identity.task_id,
        }
        validateCheckpointData(checkpoint.data, contract)
        trace.push({
          attempt,
          checkpoint_digest: checkpointDigest(checkpoint),
          kind: 'retry',
        })
      }
      fail('task-runtime-no-terminal-outcome')
    }
    let value
    let primaryError = null
    try {
      value = await run()
    } catch (error) {
      primaryError = error
    }
    let cleanupError = null
    try {
      await lifecycle.close()
    } catch (error) {
      cleanupError = error
    }
    if (primaryError !== null) throw primaryError
    if (cleanupError !== null) throw cleanupError
    return value
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'task-runtime-failure' }],
      ok: false,
    }
  }
}

function validateOutcome(outcome) {
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) {
    fail('invalid-task-performer-outcome')
  }
  const expected = outcome.kind === 'success'
    ? ['effect', 'kind', 'output']
    : outcome.kind === 'error'
      ? ['checkpoint', 'error', 'kind']
      : null
  if (expected === null) fail('invalid-task-performer-outcome')
  exactFields(outcome, expected, 'task-performer-outcome')
  if (outcome.kind === 'error') {
    if (outcome.error === null || typeof outcome.error !== 'object'
      || Array.isArray(outcome.error)
      || Object.keys(outcome.error).sort().join(',') !== 'code,message'
      || typeof outcome.error.code !== 'string'
      || typeof outcome.error.message !== 'string') {
      fail('invalid-task-error')
    }
    if (outcome.checkpoint === null || typeof outcome.checkpoint !== 'object'
      || Array.isArray(outcome.checkpoint)) fail('invalid-task-retry-checkpoint-data')
  } else if (outcome.effect !== null) {
    if (outcome.effect === null || typeof outcome.effect !== 'object'
      || Array.isArray(outcome.effect)
      || Object.keys(outcome.effect).sort().join(',') !== 'key,payload'
      || typeof outcome.effect.key !== 'string'
      || outcome.effect.key.length === 0) {
      fail('invalid-task-effect')
    }
  }
}

function validateCheckpointData(data, contract) {
  const fields = contract.checkpoint.fields.filter(
    (field) => !['revision', 'input_digest'].includes(field),
  )
  exactFields(data, fields, 'task-retry-checkpoint-data')
}

function commitEffect(effects, identity, attempt, outcome) {
  if (outcome.effect === null) fail('missing-task-effect')
  const existing = effects.get(outcome.effect.key)
  if (existing !== undefined) {
    if (existing.task_id !== identity.task_id) fail('duplicate-effect-key')
    return { effect_key: outcome.effect.key, replayed: true }
  }
  effects.set(outcome.effect.key, {
    attempt,
    effect_key: outcome.effect.key,
    output: outcome.output,
    payload: structuredClone(outcome.effect.payload),
    task_id: identity.task_id,
  })
  return { effect_key: outcome.effect.key, replayed: false }
}

function result(outcome, identity, detail) {
  return {
    ok: true,
    value: {
      ...detail,
      outcome,
      task_id: identity.task_id,
    },
  }
}

function assertOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid-task-options')
  }
  exactFields(options, RUNTIME_OPTIONS, 'task-options', { optional: RUNTIME_OPTIONS })
}

function createLifecycle(options) {
  const controller = new AbortController()
  const timeoutMs = options.timeout_ms
  if (timeoutMs !== undefined
    && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) {
    fail('invalid-task-timeout')
  }
  const signal = options.signal
  const signalCapabilities = signal === undefined ? null : snapshotTaskSignal(signal)
  const resource = options.resource
  let close = null
  if (resource !== undefined) {
    try {
      if (resource === null || typeof resource !== 'object'
        || Array.isArray(resource)) {
        fail('invalid-task-resource')
      }
      const closeMethod = resource.close
      if (typeof closeMethod !== 'function') fail('invalid-task-resource')
      close = Function.prototype.bind.call(closeMethod, resource)
    } catch (error) {
      if (error?.diagnostic?.code === 'invalid-task-resource') throw error
      fail('invalid-task-resource')
    }
  }
  let setTimer = null
  let clearTimer = null
  if (timeoutMs !== undefined) {
    let setTimeoutImpl
    let clearTimeoutImpl
    try {
      setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
      clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
    } catch {
      fail('invalid-task-timeout')
    }
    if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') {
      fail('invalid-task-timeout')
    }
    setTimer = Function.prototype.bind.call(setTimeoutImpl, undefined)
    clearTimer = Function.prototype.bind.call(clearTimeoutImpl, undefined)
  }
  let removeSignal = null
  let reason = null
  let timer = null
  let timerClear = null
  let timerEstablished = false
  let started = false
  let closed = false
  const cancel = (value) => {
    if (reason === null) reason = value
    if (!controller.signal.aborted) controller.abort()
  }
  return {
    controller,
    get reason() {
      return reason
    },
    async start() {
      if (started) return
      started = true
      if (signalCapabilities !== null) {
        const listener = () => cancel('parent')
        removeSignal = () => signalCapabilities.remove('abort', listener)
        try {
          signalCapabilities.add('abort', listener, { once: true })
        } catch {
          fail('invalid-task-signal')
        }
        if (signalCapabilities.aborted) cancel('parent')
      }
      if (timeoutMs !== undefined && reason === null) {
        timerClear = () => clearTimer(timer)
        try {
          timer = setTimer(() => cancel('timeout'), timeoutMs)
          timerEstablished = true
        } catch {
          fail('invalid-task-timeout')
        }
      }
    },
    async close() {
      if (closed) return false
      closed = true
      let firstError = null
      const remember = (error, code) => {
        if (firstError === null) {
          firstError = Object.assign(new Error(code), {
            cause: error,
            diagnostic: { code },
          })
        }
      }
      if (timerEstablished && timerClear !== null) {
        try {
          timerClear()
        } catch (error) {
          remember(error, 'invalid-task-timeout')
        }
      }
      if (removeSignal !== null) {
        try {
          removeSignal()
        } catch (error) {
          remember(error, 'invalid-task-signal')
        }
      }
      if (close !== null) {
        try {
          await Promise.resolve(close())
        } catch (error) {
          remember(error, 'task-resource-close-failure')
        }
      }
      if (firstError !== null) throw firstError
      return close !== null
    },
  }
}

function snapshotTaskSignal(signal) {
  try {
    if (signal === null || typeof signal !== 'object' || Array.isArray(signal)) {
      fail('invalid-task-signal')
    }
    const add = signal.addEventListener
    const remove = signal.removeEventListener
    const aborted = signal.aborted
    if (typeof add !== 'function'
      || typeof remove !== 'function'
      || typeof aborted !== 'boolean') {
      fail('invalid-task-signal')
    }
    return {
      aborted,
      add: Function.prototype.bind.call(add, signal),
      remove: Function.prototype.bind.call(remove, signal),
    }
  } catch (error) {
    if (error?.diagnostic?.code === 'invalid-task-signal') throw error
    fail('invalid-task-signal')
  }
}

async function finalize(value, lifecycle, { rollback = null } = {}) {
  try {
    if (await lifecycle.close()) value.value.trace.push({ kind: 'resource-close' })
    return value
  } catch (error) {
    rollback?.()
    throw error
  }
}

function exactFields(value, expected, label, { optional = [] } = {}) {
  const allowed = new Set(expected)
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) fail(`unexpected-${label}-field`, { field })
  }
  for (const field of expected) {
    if (!optional.includes(field) && !Object.hasOwn(value, field)) {
      fail(`missing-${label}-field`, { field })
    }
  }
}

function fail(code, detail = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...detail } })
}
