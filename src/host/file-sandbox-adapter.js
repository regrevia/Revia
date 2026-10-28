import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  demoResourceCatalog,
  demoResourceParents,
} from './demo-resource-contract.js'
import { snapshotUint8Array } from './uint8-array.js'

const NODE_FILE_SYSTEM = { readFileSync, realpathSync, writeFileSync }

export class FileSandboxAdapter {
  #fileSystem
  #root

  constructor({ fileSystem = NODE_FILE_SYSTEM, root }) {
    this.#fileSystem = snapshotFileSystem(fileSystem)
    this.#root = this.#fileSystem.realpathSync(root)
  }

  supportedInterfaces() {
    return ['fs.read@0.1.0', 'fs.write@0.1.0']
  }

  resourceCatalog() {
    const catalog = demoResourceCatalog()
    return {
      'fs.file': catalog['fs.file'],
      'fs.storage': catalog['fs.storage'],
    }
  }

  resourceParents() {
    return demoResourceParents()
  }

  invoke(operation, typedArguments, _invocationId) {
    if (
      operation.interface === 'fs.read@0.1.0' &&
      operation.member === 'read_file'
    ) {
      const path = sandboxPath(this.#root, typedArguments.path)
      if (path === null) {
        return declaredError('fs.read_error', 'outside_sandbox')
      }
      let bytes
      try {
        const realPath = this.#fileSystem.realpathSync(path)
        if (sandboxPath(this.#root, realPath) === null) {
          return declaredError('fs.read_error', 'outside_sandbox')
        }
        bytes = this.#fileSystem.readFileSync(realPath)
      } catch (error) {
        if (error.code === 'ENOENT') {
          return declaredError('fs.read_error', 'not_found')
        }
        if (error.code === 'EACCES' || error.code === 'EPERM') {
          return declaredError('fs.read_error', 'permission_denied')
        }
        if (typeof error.code === 'string') {
          return declaredError('fs.read_error', 'io')
        }
        throw error
      }
      bytes = snapshotUint8Array(bytes)
      if (bytes === null) {
        return declaredError('fs.read_error', 'io')
      }
      let text
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return declaredError('fs.read_error', 'invalid_utf8')
      }
      return { kind: 'value', value: { kind: 'ok', value: text } }
    }
    if (
      operation.interface === 'fs.write@0.1.0' &&
      operation.member === 'write_file'
    ) {
      const bytes = snapshotUint8Array(typedArguments.data)
      if (bytes === null) {
        return declaredError('fs.write_error', 'io')
      }
      let path = sandboxPath(this.#root, typedArguments.path)
      if (path === null) {
        return declaredError('fs.write_error', 'outside_sandbox')
      }
      try {
        const realPath = this.#fileSystem.realpathSync(path)
        if (sandboxPath(this.#root, realPath) === null) {
          return declaredError('fs.write_error', 'outside_sandbox')
        }
        path = realPath
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        try {
          const realParent = this.#fileSystem.realpathSync(dirname(path))
          if (sandboxPath(this.#root, realParent) === null) {
            return declaredError('fs.write_error', 'outside_sandbox')
          }
        } catch (parentError) {
          if (parentError.code !== 'ENOENT') throw parentError
        }
      }
      try {
        this.#fileSystem.writeFileSync(
          path,
          bytes,
        )
      } catch (error) {
        if (error.code === 'ENOENT') {
          return declaredError('fs.write_error', 'parent_not_found')
        }
        if (error.code === 'EACCES' || error.code === 'EPERM') {
          return declaredError('fs.write_error', 'permission_denied')
        }
        if (error.code === 'ENOSPC') {
          return declaredError('fs.write_error', 'no_space')
        }
        if (typeof error.code === 'string') {
          return declaredError('fs.write_error', 'io')
        }
        throw error
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

function snapshotFileSystem(fileSystem) {
  if (
    fileSystem === null
    || typeof fileSystem !== 'object'
    || Array.isArray(fileSystem)
  ) {
    throw new TypeError('fileSystem must be an object')
  }
  const methods = {}
  for (const member of ['readFileSync', 'writeFileSync', 'realpathSync']) {
    const method = fileSystem[member]
    if (typeof method !== 'function') {
      throw new TypeError(`fileSystem.${member} must be a function`)
    }
    methods[member] = Function.prototype.bind.call(method, fileSystem)
  }
  return methods
}

function sandboxPath(root, path) {
  const candidate = resolve(root, path)
  const fromRoot = relative(root, candidate)
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    return null
  }
  return candidate
}
