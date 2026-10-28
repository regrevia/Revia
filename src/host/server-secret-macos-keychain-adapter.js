import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import {
  SERVER_SECRET_ADAPTER_CONTRACT,
  SERVER_SECRET_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'
import { snapshotUint8Array } from './uint8-array.js'

const SECRET_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'secret.read')
const SECURITY_NOT_FOUND = 44

export class ServerSecretMacosKeychainAdapter {
  #entries
  #securityPath
  #spawnSync
  #statSync
  #unavailable

  constructor({
    entries = new Map(),
    securityPath = '/usr/bin/security',
    spawnSyncImpl = spawnSync,
    statSyncImpl = statSync,
    unavailable = false,
  } = {}) {
    if (!(entries instanceof Map)) {
      throw new TypeError('macOS Keychain entries must be a Map')
    }
    if (
      typeof securityPath !== 'string'
      || !isAbsolute(securityPath)
      || securityPath.includes('\u0000')
    ) {
      throw new TypeError(
        'macOS Keychain adapter requires an absolute security executable',
      )
    }
    if (typeof spawnSyncImpl !== 'function') {
      throw new TypeError('macOS Keychain adapter requires spawnSync')
    }
    if (typeof statSyncImpl !== 'function') {
      throw new TypeError('macOS Keychain adapter requires statSync')
    }
    const snapshot = []
    const iterator = Map.prototype.entries.call(entries)
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      const [name, entry] = step.value
      if (
        !validText(name)
        || entry === null
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || !validText(entry.account)
        || !validText(entry.service)
        || !validText(entry.keychain)
        || !isAbsolute(entry.keychain)
      ) {
        throw new TypeError(
          'macOS Keychain entries require text account, service, and keychain',
        )
      }
      snapshot.push([name, {
        account: entry.account,
        keychain: entry.keychain,
        service: entry.service,
      }])
    }
    this.#entries = new Map(snapshot)
    this.#securityPath = securityPath
    this.#spawnSync = spawnSyncImpl
    this.#statSync = statSyncImpl
    this.#unavailable = unavailable
  }

  adapterContract() {
    return SERVER_SECRET_ADAPTER_CONTRACT
  }

  supportedInterfaces() {
    return [SERVER_SECRET_REFERENCE]
  }

  resourceCatalog() {
    return structuredClone(SECRET_SCHEMA.resource_catalog)
  }

  resourceParents() {
    return structuredClone(SECRET_SCHEMA.resource_parents)
  }

  invoke(operation, typedArguments) {
    if (
      operation.interface !== SERVER_SECRET_REFERENCE
      || operation.member !== 'get'
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#unavailable) return declaredError('unavailable')
    const entry = this.#entries.get(typedArguments.name)
    if (entry === undefined) return declaredError('not_found')

    const before = keychainIdentity(this.#statSync, entry.keychain)
    if (before === null) return declaredError('unavailable')
    let result
    try {
      result = this.#spawnSync(this.#securityPath, [
        'find-generic-password',
        '-a',
        entry.account,
        '-s',
        entry.service,
        '-g',
        entry.keychain,
      ], {
        encoding: null,
        env: { LANG: 'C', LC_ALL: 'C' },
        maxBuffer: 1024 * 1024,
        shell: false,
        windowsHide: true,
      })
    } catch {
      return declaredError('unavailable')
    }
    const after = keychainIdentity(this.#statSync, entry.keychain)
    if (after === null || before.dev !== after.dev || before.ino !== after.ino) {
      return declaredError('unavailable')
    }
    if (result?.status === SECURITY_NOT_FOUND) {
      return declaredError('not_found')
    }
    if (
      result === null
      || typeof result !== 'object'
      || result.error !== undefined
      || result.signal !== null && result.signal !== undefined
      || result.status !== 0
      || !(result.stderr instanceof Uint8Array)
    ) {
      return declaredError('unavailable')
    }
    let secret
    try {
      const stderr = snapshotUint8Array(result.stderr)
      if (stderr === null) return declaredError('unavailable')
      secret = parsePasswordOutput(stderr)
      new TextDecoder('utf-8', { fatal: true }).decode(secret)
    } catch {
      return declaredError('unavailable')
    }
    return {
      kind: 'value',
      value: { kind: 'ok', value: new Uint8Array(secret) },
    }
  }
}

function keychainIdentity(statSyncImpl, path) {
  try {
    const stat = statSyncImpl(path)
    if (
      stat === null
      || typeof stat !== 'object'
      || typeof stat.isFile !== 'function'
      || !stat.isFile()
      || !['bigint', 'number'].includes(typeof stat.dev)
      || !['bigint', 'number'].includes(typeof stat.ino)
    ) {
      return null
    }
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

function parsePasswordOutput(stderr) {
  const text = new TextDecoder('utf-8', { fatal: true })
    .decode(stderr)
  const lines = text.split('\n')
    .filter((line) => line.startsWith('password: '))
  if (lines.length !== 1) {
    throw new TypeError('ambiguous Keychain password output')
  }
  const hex = /^password: 0x([0-9A-F]+)(?:\s+.*)?$/.exec(lines[0])
  if (hex !== null) {
    if (hex[1].length % 2 !== 0) {
      throw new TypeError('invalid Keychain password hex')
    }
    return Uint8Array.from(Buffer.from(hex[1], 'hex'))
  }
  const quoted = /^password: "([^"\\]*)"$/.exec(lines[0])
  if (
    quoted === null
    || [...quoted[1]].some((character) => {
      const code = character.codePointAt(0)
      return code < 0x20 || code > 0x7e
    })
  ) {
    throw new TypeError('invalid Keychain password text')
  }
  return new TextEncoder().encode(quoted[1])
}

function validText(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && !value.includes('\u0000')
  )
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'secret.read_error', variant },
      kind: 'err',
    },
  }
}
