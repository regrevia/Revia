import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import {
  platform,
  tmpdir,
} from 'node:os'
import { isAbsolute, join } from 'node:path'

import {
  standaloneFaultHostCSource,
} from './standalone-fault-host-boundary.js'
import {
  standaloneMinimalStdCSource,
} from './standalone-minimal-std.js'
import {
  standalonePortableVmCSource,
} from './standalone-portable-vm.js'
import {
  standaloneTaskLifecycleCSource,
} from './standalone-task-lifecycle-core.js'

export const STANDALONE_PORTABLE_EXECUTABLE_PROFILE =
  're.standalone-portable-executable@0.1.0'
export const STANDALONE_PORTABLE_EXECUTABLE_ERROR_SCHEMA =
  're.standalone-portable-executable-error@0.1.0'

const MAGIC_BYTES = 8
const MAX_WIRE_BYTES = 44 + 65_535 + 1
const ROUTES = Object.freeze([
  ['REVMREQ1', 'vm', 're_run_vm'],
  ['RESTREQ1', 'minimal_std', 're_run_minimal_std'],
  ['REFLREQ1', 'fault', 're_run_fault'],
  ['RETLREQ1', 'task_lifecycle', 're_run_task_lifecycle'],
])
const ROUTE_BY_MAGIC = new Map(ROUTES.map(([magic, name]) => [magic, name]))

export async function buildStandalonePortableExecutable({
  compiler_path,
  root,
  target_triple,
  task_reference,
} = {}) {
  validateBuildInputs({
    compiler_path,
    root,
    target_triple,
    task_reference,
  })
  const sources = standalonePortableExecutableSources({ task_reference })
  const sourcePaths = []
  for (const [name, source] of Object.entries(sources)) {
    const sourcePath = join(root, `${name}.c`)
    await writeFile(sourcePath, source, 'utf8')
    sourcePaths.push(sourcePath)
  }
  const executablePath = join(
    root,
    platform() === 'win32'
      ? 're-standalone-portable.exe'
      : 're-standalone-portable',
  )
  const built = spawnSync(compiler_path, [
    '-O2',
    '-std=c11',
    '-target',
    target_triple,
    ...sourcePaths,
    '-o',
    executablePath,
  ], { encoding: 'utf8', shell: false })
  if (built.error?.code === 'ENOENT') {
    fail('standalone-portable-executable-compiler-missing')
  }
  if (built.error || built.status !== 0) {
    fail('standalone-portable-executable-compile-failed')
  }
  const sourceDigest = digestBytes(Buffer.from(
    Object.entries(sources)
      .map(([name, source]) => `${name}\0${source}`)
      .join('\0'),
    'utf8',
  ))
  return {
    executable_digest: digestBytes(await readFile(executablePath)),
    executable_path: executablePath,
    profile: STANDALONE_PORTABLE_EXECUTABLE_PROFILE,
    source_digest: sourceDigest,
    sources: Object.freeze(Object.keys(sources)),
  }
}

export async function runStandalonePortableExecutableWire({
  compiler_path,
  target_triple,
  task_reference,
  wire,
} = {}) {
  let root = null
  try {
    validateWireInputs({
      compiler_path,
      target_triple,
      task_reference,
      wire,
    })
    root = await mkdtemp(join(tmpdir(), 're-standalone-portable-'))
    const built = await buildStandalonePortableExecutable({
      compiler_path,
      root,
      target_triple,
      task_reference,
    })
    return executeStandalonePortableExecutable(built.executable_path, wire)
  } catch (error) {
    return rejected(
      error?.code ?? 'standalone-portable-executable-run-failed',
    )
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export function executeStandalonePortableExecutable(executablePath, wire) {
  if (!isAbsolute(executablePath) || !Buffer.isBuffer(wire)) {
    return rejected('standalone-portable-executable-input-invalid')
  }
  const executed = spawnSync(executablePath, [], {
    encoding: null,
    input: wire,
    maxBuffer: 1024 * 1024,
    shell: false,
  })
  const stdout = Buffer.from(executed.stdout ?? [])
  if (executed.status !== 0) {
    const match = stdout.toString('ascii').match(/^REUNERR1:([0-9]+)\n$/u)
    if (match !== null) {
      return rejected(ROUTE_ERRORS[Number(match[1])]
        ?? 'standalone-portable-executable-route-failed')
    }
    return rejected('standalone-portable-executable-domain-failed')
  }
  if (executed.error || Buffer.from(executed.stderr ?? []).length !== 0) {
    return rejected('standalone-portable-executable-run-failed')
  }
  return {
    ok: true,
    response_wire: stdout,
  }
}

export function standalonePortableExecutableSources({ task_reference } = {}) {
  if (!plainObject(task_reference)) {
    fail('standalone-portable-executable-task-reference-invalid')
  }
  return {
    're-standalone-vm': withPrefixRunner(
      standalonePortableVmCSource(),
      're_run_vm',
    ),
    're-standalone-minimal-std': withPrefixRunner(
      standaloneMinimalStdCSource(),
      're_run_minimal_std',
    ),
    're-standalone-fault': withPrefixRunner(
      standaloneFaultHostCSource(),
      're_run_fault',
    ),
    're-standalone-task-lifecycle': withPrefixRunner(
      standaloneTaskLifecycleCSource(task_reference),
      're_run_task_lifecycle',
    ),
    're-standalone-dispatcher': dispatcherSource(),
  }
}

function withPrefixRunner(source, name) {
  const mainMarker = 'int main(void) {'
  const readMarker =
    'size_t count = fread(input, 1u, sizeof(input), stdin);'
  if (source.split(mainMarker).length !== 2
    || source.split(readMarker).length !== 2) {
    fail('standalone-portable-executable-source-shape-invalid')
  }
  return source
    .replace(mainMarker, `int ${name}(const unsigned char *prefix) {`)
    .replace(
      readMarker,
      [
        'memcpy(input, prefix, 8u);',
        'size_t count = 8u + fread(',
        'input + 8u, 1u, sizeof(input) - 8u, stdin);',
      ].join(''),
    )
}

function dispatcherSource() {
  const prototypes = ROUTES.map(([, , runner]) =>
    `int ${runner}(const unsigned char *prefix);`).join('\n')
  const branches = ROUTES.map(([magic, , runner]) =>
    `  if (memcmp(prefix, "${magic}", 8u) == 0) `
    + `return ${runner}(prefix);`).join('\n')
  return `#include <stdio.h>
#include <string.h>

${prototypes}

static int route_error(unsigned code) {
  printf("REUNERR1:%u\\n", code);
  return 78;
}

int main(void) {
  unsigned char prefix[8];
  if (fread(prefix, 1u, 8u, stdin) != 8u) return route_error(1u);
${branches}
  return route_error(3u);
}
`
}

function validateBuildInputs({
  compiler_path,
  root,
  target_triple,
  task_reference,
}) {
  if (!isAbsolute(compiler_path)
    || !isAbsolute(root)
    || typeof target_triple !== 'string'
    || target_triple.length === 0
    || !plainObject(task_reference)
    || !Array.isArray(task_reference.workloads)) {
    fail('standalone-portable-executable-input-invalid')
  }
}

function validateWireInputs(inputs) {
  validateBuildInputs(inputs)
  if (!Buffer.isBuffer(inputs.wire)
    || inputs.wire.length > MAX_WIRE_BYTES) {
    fail('standalone-portable-executable-wire-invalid')
  }
}

const ROUTE_ERRORS = Object.freeze({
  1: 'wire-truncated',
  3: 'wire-magic-mismatch',
})

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}

export function standalonePortableExecutableRoute(magic) {
  return ROUTE_BY_MAGIC.get(magic) ?? null
}
