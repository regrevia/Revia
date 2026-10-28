import { posix } from 'node:path'
import {
  demoResourceCatalog,
  demoResourceParents,
} from './demo-resource-contract.js'
import { snapshotUint8Array } from './uint8-array.js'

const DEMO_INTERFACES = [
  'fs.read@0.1.0',
  'fs.write@0.1.0',
  'process.args@0.1.0',
  'process.stdout@0.1.0',
]

export class MemoryAdapter {
  #argv
  #files
  #externalFiles
  #stdout
  #stdoutBroken

  constructor({ argv = [], files = new Map(), stdout = [], stdoutBroken = false } = {}) {
    this.#argv = snapshotArgv(argv)
    this.#files = snapshotFiles(files)
    this.#externalFiles = files
    this.#stdout = stdout
    this.#stdoutBroken = stdoutBroken
  }

  supportedInterfaces() {
    return [...DEMO_INTERFACES]
  }

  resourceCatalog() {
    return demoResourceCatalog()
  }

  resourceParents() {
    return demoResourceParents()
  }

  invoke(operation, _arguments, _invocationId) {
    if (
      operation.interface === 'process.args@0.1.0' &&
      operation.member === 'read'
    ) {
      let argv
      try {
        argv = this.#argv.map((argument) =>
          argument instanceof Uint8Array
            ? new TextDecoder('utf-8', { fatal: true }).decode(argument)
            : argument,
        )
      } catch {
        return declaredError('process.args_error', 'invalid_utf8')
      }
      return {
        kind: 'value',
        value: { kind: 'ok', value: argv },
      }
    }
    if (
      operation.interface === 'fs.read@0.1.0' &&
      operation.member === 'read_file'
    ) {
      const path = sandboxPath(_arguments.path)
      if (path === null) {
        return declaredError('fs.read_error', 'outside_sandbox')
      }
      const file = this.#files.get(path)
      if (file === undefined) {
        return declaredError('fs.read_error', 'not_found')
      }
      if (file.readable === false) {
        return declaredError('fs.read_error', 'permission_denied')
      }
      let text
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
      } catch {
        return declaredError('fs.read_error', 'invalid_utf8')
      }
      return {
        kind: 'value',
        value: {
          kind: 'ok',
          value: text,
        },
      }
    }
    if (
      operation.interface === 'fs.write@0.1.0' &&
      operation.member === 'write_file'
    ) {
      const bytes = snapshotUint8Array(_arguments.data)
      if (bytes === null) {
        return declaredError('fs.write_error', 'io')
      }
      const path = sandboxPath(_arguments.path)
      if (path === null) {
        return declaredError('fs.write_error', 'outside_sandbox')
      }
      const existing = this.#files.get(path)
      if (existing?.writable === false) {
        return declaredError('fs.write_error', 'permission_denied')
      }
      const record = {
        bytes,
        readable: true,
        writable: true,
      }
      this.#files.set(path, record)
      Map.prototype.set.call(this.#externalFiles, path, {
        bytes: new Uint8Array(bytes),
        readable: true,
        writable: true,
      })
      return { kind: 'value', value: { kind: 'ok', value: null } }
    }
    if (
      operation.interface === 'process.stdout@0.1.0' &&
      operation.member === 'write'
    ) {
      if (this.#stdoutBroken) {
        return declaredError('io.write_error', 'broken_pipe')
      }
      if (_arguments.data.length > 0) {
        this.#stdout.push(_arguments.data)
      }
      return { kind: 'value', value: { kind: 'ok', value: null } }
    }
    throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
  }
}

function declaredError(type, variant) {
  return {
    kind: 'value',
    value: { error: { type, variant }, kind: 'err' },
  }
}

function snapshotArgv(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('argv must be an Array')
  }
  try {
    const length = argv.length
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError()
    }
    const snapshot = []
    for (let index = 0; index < length; index += 1) {
      const argument = argv[index]
      if (typeof argument === 'string') {
        snapshot.push(argument)
        continue
      }
      if (argument instanceof Uint8Array) {
        const bytes = snapshotUint8Array(argument)
        if (bytes === null) throw new TypeError()
        snapshot.push(bytes)
        continue
      }
      throw new TypeError()
    }
    return snapshot
  } catch {
    throw new TypeError('argv must contain strings or Uint8Array values')
  }
}

function snapshotFiles(files) {
  if (!(files instanceof Map)) {
    throw new TypeError('files must be a Map')
  }
  const snapshot = new Map()
  try {
    const iterator = Map.prototype.entries.call(files)
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      const [path, file] = step.value
      const bytes = snapshotUint8Array(file?.bytes)
      if (
        typeof path !== 'string'
        || file === null
        || typeof file !== 'object'
        || bytes === null
      ) {
        throw new TypeError()
      }
      snapshot.set(path, {
        bytes,
        readable: file.readable,
        writable: file.writable,
      })
    }
  } catch {
    throw new TypeError('files must map paths to file records')
  }
  return snapshot
}

function sandboxPath(path) {
  if (posix.isAbsolute(path)) return null
  const normalized = posix.normalize(path)
  if (normalized === '..' || normalized.startsWith('../')) return null
  return normalized
}
