#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  lstat,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Filled from the selection module inside the guarded block below, so a tree
// that lost that module reports a name instead of a Node stack.
let ALLOWLIST_SCHEMA
let compareUtf8
let renderAllowlist
let selectFiles

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const ALLOWLIST = join(ROOT, 'SOURCE_IMPORT_FILES.json')
const MANIFEST = join(ROOT, 'SOURCE_IMPORT_MANIFEST.json')
// A leading mark is well-formed UTF-8, so nothing below can tell a marked
// document from a corrupt one once it has been decoded: the bytes are refused
// here, by name, before any parse or comparison sees the text.
const BYTE_ORDER_MARK = Buffer.from([0xef, 0xbb, 0xbf])
const BYTE_ORDER_MARK_CODE = 'byte-order-mark-not-allowed'

const mode = process.argv[2]
if (!['--refresh', '--write', '--check'].includes(mode)) {
  process.stderr.write(
    'Usage: node scripts/build-source-import-manifest.js --refresh|--write|--check\n',
  )
  process.exit(64)
}

try {
  // The module that reads and renders the list is a tracked file the build
  // must publish, so losing it is not a stale entry and no refresh brings it
  // back. A static import would raise before this block and let a Node stack
  // reach stderr; loading it here keeps every fault named. Only the module
  // being gone is mapped, so a broken one still reports what broke.
  ;({ ALLOWLIST_SCHEMA, compareUtf8, renderAllowlist, selectFiles } =
    await import('./source-import-selection.mjs').catch((error) => {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error('source-import-selection-missing')
      }
      throw error
    }))
  // The list is read in every mode and rewritten in one, and a link is
  // neither a list nor an absent one: the write would land on whatever it
  // points at while the tracked file stayed a link, and a dangling link reads
  // exactly like a tree that never had a list.
  const allowlistStat = await lstat(ALLOWLIST).catch(() => null)
  if (allowlistStat?.isSymbolicLink()) {
    throw new Error('source-import-allowlist-symlink')
  }
  if (mode === '--refresh') {
    // --check refuses a marked allowlist, so --refresh has to refuse it too;
    // rewriting the file would silently erase the one thing that was wrong.
    // A path that holds something other than a file cannot carry a mark, so
    // there is nothing here to refuse and the write below reports the fault.
    await readMarked(ALLOWLIST).catch((error) => {
      if (error?.code === 'EISDIR') return null
      // A list the process may not read stops this mode as surely as one it
      // may not write, and the raw refusal carried a path stableCode() drops.
      // Only a file-system error is mapped: the mark refusal carries no code
      // and has to reach the operator as itself.
      if (typeof error?.code === 'string') {
        throw new Error('source-import-allowlist-unreadable')
      }
      throw error
    })
    const files = await selectFiles(ROOT)
    // --refresh is the only mode that writes the list, so a path that will
    // not take it stops the repair the operator ran this mode for. Left bare,
    // the EISDIR carried an absolute path that stableCode() dropped.
    await writeFile(ALLOWLIST, renderAllowlist(files)).catch(() => {
      throw new Error('source-import-allowlist-unwritable')
    })
  }
  const allowlist = await readAllowlist()
  const manifest = await buildManifest(allowlist)
  const bytes = Buffer.from(canonicalJson(manifest))
  // Every mode either compares the manifest or replaces it, and a link is
  // neither: the write would land on whatever it points at, leave the link in
  // the tree, and still report the bytes it computed. Reading follows the link
  // too, so a dangling one looks exactly like an absent manifest. Letting
  // ENOENT through keeps the missing case with the modes that own it.
  const manifestStat = await lstat(MANIFEST).catch(() => null)
  if (manifestStat?.isSymbolicLink()) {
    throw new Error('source-import-manifest-symlink')
  }
  if (mode === '--check') {
    // The manifest is compared, not parsed, so a missing one is not drift: no
    // bytes to differ from. Reading it threw a raw ENOENT with an absolute
    // path, which stableCode() drops to the unnamed failure.
    // An absent manifest and a path that holds something other than one are
    // different repairs, and only the first is --refresh's job: a directory
    // here is never made a manifest by writing one. The raw EISDIR carried an
    // absolute path that stableCode() dropped.
    const existing = refuseMark(await readFile(MANIFEST).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error('source-import-manifest-missing')
      throw new Error('source-import-manifest-unreadable')
    }))
    if (!existing.equals(bytes)) throw new Error('source-import-manifest-drift')
  } else {
    // The write either lands or it does not, so every failure here is the
    // same fault: the path cannot take the file. A directory sitting on it
    // threw EISDIR with an absolute path, which stableCode() dropped to the
    // unnamed failure.
    await writeFile(MANIFEST, bytes).catch(() => {
      throw new Error('source-import-manifest-unwritable')
    })
  }
  process.stdout.write(`${canonicalJson({
    file_count: manifest.files.length,
    manifest_digest: digest(bytes),
    schema: 'revia.source-import-manifest-result@1.0.0',
  })}`)
} catch (error) {
  process.stderr.write(`${stableCode(error)}\n`)
  process.exitCode = 1
}

async function readAllowlist() {
  // --refresh writes this file; every other mode reads it. Without it there is
  // no list to compare or to write from, and the raw ENOENT it threw carried
  // an absolute path that stableCode() dropped to the unnamed failure.
  // An absent list and a path that holds something other than a list are
  // different repairs, and only the first is --refresh's job. The second never
  // reaches a parse, so no content name below can describe it; the raw EISDIR
  // carried an absolute path that stableCode() dropped.
  const source = await readFile(ALLOWLIST).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error('source-import-allowlist-missing')
    throw new Error('source-import-allowlist-unreadable')
  })
  // A list that is present but holds nothing JSON.parse() can read is not a
  // stale entry and not a layout the schema can describe: it is a file that
  // has to be restored, and the raw SyntaxError carried no name from the
  // vocabulary, so every mode used to print the unnamed failure.
  const value = (() => {
    try {
      return JSON.parse(refuseMark(source).toString('utf8'))
    } catch (error) {
      if (error?.message === BYTE_ORDER_MARK_CODE) throw error
      throw new Error('source-import-allowlist-unparseable')
    }
  })()
  if (value?.schema !== ALLOWLIST_SCHEMA
    || !Array.isArray(value.files)
    || value.files.length === 0
    || value.files.some((path) => !safePath(path))) {
    throw new Error('source-import-allowlist-invalid')
  }
  const sorted = [...new Set(value.files)].sort(compareUtf8)
  if (sorted.length !== value.files.length
    || value.files.some((path, index) => path !== sorted[index])) {
    throw new Error('source-import-allowlist-order-invalid')
  }
  return value
}

function refuseMark(bytes) {
  if (bytes.subarray(0, BYTE_ORDER_MARK.length).equals(BYTE_ORDER_MARK)) {
    throw new Error(BYTE_ORDER_MARK_CODE)
  }
  return bytes
}

async function readMarked(path) {
  try {
    return refuseMark(await readFile(path))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function buildManifest(allowlist) {
  const files = []
  for (const path of allowlist.files) {
    const absolute = join(ROOT, path)
    // A path that is not there and a path that is there but is not a file are
    // different repairs: one means the allowlist is stale, the other means the
    // tree holds a directory or a link where a file belongs.
    const stat = await lstat(absolute).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error('source-import-file-missing')
      // Everything else is a path the process cannot look at: a directory it
      // may not enter, a mount that went away, a file whose name is too long.
      // The raw error carried an absolute path that stableCode() drops.
      throw new Error('source-import-file-unreadable')
    })
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('source-import-file-invalid')
    }
    // The stat said it was a file; the read can still be refused, and a race
    // that removed it between the two calls is the same repair as before.
    const bytes = await readFile(absolute).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error('source-import-file-missing')
      throw new Error('source-import-file-unreadable')
    })
    files.push({
      bytes: bytes.length,
      path,
      sha256: digest(bytes),
    })
  }
  return {
    files,
    license: 'MPL-2.0',
    schema: 'revia.source-import@1.0.0',
  }
}

function safePath(path) {
  if (typeof path !== 'string' || path.length === 0
    || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  const segments = path.split('/')
  return segments.every((segment) => (
    segment.length > 0 && segment !== '.' && segment !== '..'
  )) && segments[0] !== '.git'
}

function canonicalJson(value) {
  return `${JSON.stringify(sortValue(value))}\n`
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort(compareUtf8).map((key) => [key, sortValue(value[key])]),
    )
  }
  return value
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function stableCode(error) {
  return typeof error?.message === 'string'
    && /^[a-z0-9-]+$/u.test(error.message)
    ? error.message
    : 'source-import-failed'
}
