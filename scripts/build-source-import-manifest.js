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

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const ALLOWLIST = join(ROOT, 'SOURCE_IMPORT_FILES.json')
const MANIFEST = join(ROOT, 'SOURCE_IMPORT_MANIFEST.json')
const SOURCE_ROOTS = [
  'doc',
  'native',
  'src',
  'test',
  'test-support',
]
const EXPLICIT_PATHS = [
  '.gitattributes',
  '.gitignore',
  '.github/workflows/validate.yml',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'LICENSE-PREVIEW-0.1.md',
  'NOTICE.md',
  'NOTICE-PREVIEW-0.1.md',
  'QUICKSTART.md',
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'SOURCE-LICENSE.md',
  'package.json',
  'examples/agent-expense-review-run.json',
  'examples/agent-expense-review',
  'examples/args-check.re',
  'examples/cf-branch.re',
  'examples/cf-concurrent.re',
  'examples/cf-loop.re',
  'examples/cf-retry.re',
  'examples/p0-demo-runtime.re',
  'examples/read-check.re',
  'examples/read-encoding.re',
  'examples/schema-ops.re',
  'examples/write-check.re',
  'scripts/build-source-import-manifest.js',
  'scripts/run-agent-authoring-loop-conformance.js',
  'scripts/run-agent-project-benchmark.js',
  'scripts/run-agent-writing-evaluation.js',
  'scripts/run-backend-feasibility.js',
  'scripts/run-external-runner.js',
  'scripts/run-human-semantic-review-conformance.js',
  'scripts/run-llvm-aot-external-evidence.js',
  'scripts/run-minimal-std-abi.js',
  'scripts/run-minimal-std-cache.js',
  'scripts/run-minimal-std-native-runner.js',
  'scripts/run-module-artifact-cache-benchmark.js',
  'scripts/run-native-runtime-abi.js',
  'scripts/run-portable-conformance-matrix.js',
  'scripts/portable-conformance-evidence-store.js',
  'scripts/run-portable-execution-hard-gate.js',
  'scripts/run-portable-executor-benchmark.js',
  'scripts/run-portable-fault-protocol-benchmark.js',
  'scripts/run-portable-runtime-abi.js',
  'scripts/run-portable-runtime-package.js',
  'scripts/run-portable-vm-aot.js',
  'scripts/run-portable-vm-conformance.js',
  'scripts/run-portable-vm-std.js',
  'scripts/run-project-build-benchmark.js',
  'scripts/run-public-ai-native-demo.js',
  'scripts/run-real-host-adapter-evidence.js',
  'scripts/run-standalone-cross-platform-ci-claim.js',
  'scripts/run-standalone-fault-host-boundary.js',
  'scripts/run-standalone-minimal-std.js',
  'scripts/run-standalone-portable-vm.js',
  'scripts/run-standalone-semantic-performance-hard-gate.js',
  'scripts/run-standalone-task-lifecycle-core.js',
  'scripts/run-task-runtime-lifecycle-benchmark.js',
  'scripts/run-tracked-tests.js',
  'scripts/validate-public-tree.sh',
]

const mode = process.argv[2]
if (!['--refresh', '--write', '--check'].includes(mode)) {
  process.stderr.write(
    'Usage: node scripts/build-source-import-manifest.js --refresh|--write|--check\n',
  )
  process.exit(64)
}

try {
  if (mode === '--refresh') {
    const files = await selectedFiles()
    await writeFile(ALLOWLIST, `${canonicalJson({
      files,
      schema: 'revia.source-import-allowlist@1.0.0',
    })}`)
  }
  const allowlist = await readAllowlist()
  const manifest = await buildManifest(allowlist)
  const bytes = Buffer.from(canonicalJson(manifest))
  if (mode === '--check') {
    const existing = await readFile(MANIFEST)
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

async function selectedFiles() {
  const selected = new Set()
  for (const root of SOURCE_ROOTS) {
    for (const path of await walk(root)) selected.add(path)
  }
  for (const entry of EXPLICIT_PATHS) {
    const stat = await lstat(join(ROOT, entry))
    if (stat.isSymbolicLink()) throw new Error('source-import-symlink')
    if (stat.isDirectory()) {
      for (const path of await walk(entry)) selected.add(path)
    } else if (stat.isFile()) {
      selected.add(entry)
    } else {
      throw new Error('source-import-entry-invalid')
    }
  }
  return [...selected].sort(compareUtf8)
}

async function walk(relative) {
  const absolute = join(ROOT, relative)
  const entries = await readdir(absolute, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
    if (entry.isDirectory() && ['node_modules', 'scratch', 'target'].includes(entry.name)) {
      continue
    }
    const path = `${relative}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error('source-import-symlink')
    if (entry.isDirectory()) files.push(...await walk(path))
    else if (entry.isFile()) files.push(path)
    else throw new Error('source-import-entry-invalid')
  }
  return files
}

async function readAllowlist() {
  const value = JSON.parse(await readFile(ALLOWLIST, 'utf8'))
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

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
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
