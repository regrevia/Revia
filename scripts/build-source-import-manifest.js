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
import { compareUtf8, selectFiles } from './source-import-selection.mjs'

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
  if (mode === '--refresh') {
    // --check refuses a marked allowlist, so --refresh has to refuse it too;
    // rewriting the file would silently erase the one thing that was wrong.
    await readMarked(ALLOWLIST)
    const files = await selectFiles(ROOT)
    await writeFile(ALLOWLIST, `${canonicalJson({
      files,
      schema: 'revia.source-import-allowlist@1.0.0',
    })}`)
  }
  const allowlist = await readAllowlist()
  const manifest = await buildManifest(allowlist)
  const bytes = Buffer.from(canonicalJson(manifest))
  if (mode === '--check') {
    const existing = refuseMark(await readFile(MANIFEST))
    if (!existing.equals(bytes)) throw new Error('source-import-manifest-drift')
  } else {
    await writeFile(MANIFEST, bytes)
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
  const value = JSON.parse(refuseMark(await readFile(ALLOWLIST)).toString('utf8'))
  if (value?.schema !== 'revia.source-import-allowlist@1.0.0'
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
    const stat = await lstat(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('source-import-file-invalid')
    }
    const bytes = await readFile(absolute)
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
