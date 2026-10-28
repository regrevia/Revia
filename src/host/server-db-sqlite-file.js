import { lstatSync, realpathSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const NODE_FILE_SYSTEM = { lstatSync, realpathSync }
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u
const FILE_HANDLES = new WeakMap()

export function createServerDbSqliteFileHandle({
  database_path,
  file_system = NODE_FILE_SYSTEM,
  root,
} = {}) {
  const fileSystem = snapshotFileSystem(file_system)
  const rootPath = validateAbsolutePath(root)
  const databasePath = validateAbsolutePath(database_path)
  const rootStat = safeLstat(fileSystem, rootPath)
  if (rootStat === null || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw invalidPath()
  }

  const realRoot = safeRealpath(fileSystem, rootPath)
  if (realRoot === null) throw invalidPath()
  const realParent = safeRealpath(fileSystem, dirname(databasePath))
  if (realParent === null || !inside(realRoot, realParent)) {
    throw invalidPath()
  }

  const existing = safeLstat(fileSystem, databasePath)
  if (
    existing !== null
    && (existing.isSymbolicLink() || !existing.isFile())
  ) {
    throw invalidPath()
  }

  let database
  try {
    database = new DatabaseSync(databasePath)
    database.prepare('PRAGMA schema_version').get()
    const opened = safeLstat(fileSystem, databasePath)
    const realDatabase = safeRealpath(fileSystem, databasePath)
    if (
      opened === null
      || opened.isSymbolicLink()
      || !opened.isFile()
      || realDatabase === null
      || !inside(realRoot, realDatabase)
    ) {
      throw invalidPath()
    }
    const close = snapshotMethod(database, 'close')
    let closed = false
    const closeHandle = () => {
      if (closed) return { error: 'closed', ok: false }
      try {
        close()
        closed = true
        notifyClose()
        return { ok: true }
      } catch {
        closed = true
        notifyClose()
        return { error: 'unavailable', ok: false }
      }
    }
    function notifyClose() {
      const authority = FILE_HANDLES.get(handle)
      if (authority === undefined) return
      for (const subscriber of authority.subscribers) {
        try {
          subscriber()
        } catch {
          // A subscriber cannot replace the file-handle lifecycle result.
        }
      }
      authority.subscribers.clear()
    }
    const handle = Object.freeze({
      close: closeHandle,
      database,
    })
    FILE_HANDLES.set(handle, {
      close: closeHandle,
      database,
      path: databasePath,
      subscribers: new Set(),
      state: () => closed,
    })
    return handle
  } catch (error) {
    try {
      database?.close()
    } catch {
      // The sanitized construction error remains authoritative.
    }
    if (error?.message === 'invalid SQLite file path') throw error
    throw invalidHandle()
  }
}

export function openServerDbSqliteFileConnection(fileHandle) {
  const authority = FILE_HANDLES.get(fileHandle)
  if (authority === undefined || authority.state()) throw invalidHandle()
  let database
  try {
    database = new DatabaseSync(authority.path)
    database.prepare('PRAGMA schema_version').get()
    const close = snapshotMethod(database, 'close')
    return {
      close,
      database,
    }
  } catch {
    try {
      database?.close()
    } catch {
      // The sanitized construction error remains authoritative.
    }
    throw invalidHandle()
  }
}

export function getServerDbSqliteFileDatabase(fileHandle) {
  const authority = FILE_HANDLES.get(fileHandle)
  if (authority === undefined || authority.state()) throw invalidHandle()
  return authority.database
}

export function getServerDbSqliteFileClose(fileHandle) {
  const authority = FILE_HANDLES.get(fileHandle)
  if (authority === undefined || authority.state()) throw invalidHandle()
  return authority.close
}

export function subscribeServerDbSqliteFileClose(fileHandle, callback) {
  const authority = FILE_HANDLES.get(fileHandle)
  if (
    authority === undefined
    || typeof callback !== 'function'
  ) {
    throw invalidHandle()
  }
  if (authority.state()) {
    callback()
    return () => {}
  }
  authority.subscribers.add(callback)
  return () => authority.subscribers.delete(callback)
}

function validateAbsolutePath(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !isAbsolute(value)
    || URL_LIKE.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidPath()
  }
  return resolve(value)
}

function snapshotFileSystem(fileSystem) {
  if (
    fileSystem === null
    || typeof fileSystem !== 'object'
    || Array.isArray(fileSystem)
  ) {
    throw invalidHandle()
  }
  const methods = {}
  for (const member of ['lstatSync', 'realpathSync']) {
    const method = fileSystem[member]
    if (typeof method !== 'function') throw invalidHandle()
    methods[member] = Function.prototype.bind.call(method, fileSystem)
  }
  return methods
}

function safeLstat(fileSystem, path) {
  try {
    return fileSystem.lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw invalidHandle()
  }
}

function safeRealpath(fileSystem, path) {
  try {
    return fileSystem.realpathSync(path)
  } catch {
    return null
  }
}

function snapshotMethod(receiver, member) {
  const method = receiver[member]
  if (typeof method !== 'function') throw invalidHandle()
  return Function.prototype.bind.call(method, receiver)
}

function inside(root, candidate) {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  )
}

function invalidPath() {
  return new TypeError('invalid SQLite file path')
}

function invalidHandle() {
  return new TypeError('invalid SQLite file handle')
}
