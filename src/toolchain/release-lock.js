import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const DIGEST = /^sha256:[0-9a-f]{64}$/
const SCHEMA = 're.g6-release-lock@0.1.0'

export async function loadReleaseLock(url) {
  return JSON.parse(await readFile(url, 'utf8'))
}

export function releaseLockDigest(lock) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(lock))
    .digest('hex')}`
}

export function assertReleaseLock(lock, pack, packDigest) {
  if (!plainObject(lock) || lock.schema !== SCHEMA) {
    throw new TypeError('unsupported G6 release lock')
  }
  if (lock.task_pack_schema !== pack.schema) {
    throw new TypeError('release lock task pack schema mismatch')
  }
  if (lock.task_pack_digest !== packDigest || !DIGEST.test(lock.task_pack_digest)) {
    throw new TypeError('release lock task pack digest mismatch')
  }
  if (!sameArray(lock.model_ids, pack.models)) {
    throw new TypeError('release lock model slots mismatch')
  }
  if (!sameArray(lock.allowed_tools, pack.allowed_tools)) {
    throw new TypeError('release lock tool allowlist mismatch')
  }
  if (!plainObject(lock.runner) ||
      lock.runner.protocol !== 'ollama.generate' ||
      lock.runner.stream !== false ||
      lock.runner.temperature !== 0) {
    throw new TypeError('release lock runner mismatch')
  }
  const budget = lock.budget
  if (!plainObject(budget) ||
      !positiveInteger(budget.max_tool_rounds) ||
      !positiveInteger(budget.max_total_tokens) ||
      !positiveInteger(budget.max_output_tokens_per_call) ||
      !positiveInteger(budget.request_timeout_ms) ||
      budget.max_tool_rounds > 100 ||
      budget.max_output_tokens_per_call > budget.max_total_tokens ||
      budget.request_timeout_ms > 300_000) {
    throw new TypeError('invalid G6 release lock budget')
  }
  return lock
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

function sameArray(left, right) {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
