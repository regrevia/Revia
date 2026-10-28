import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  arch,
  platform,
  release,
  tmpdir,
} from 'node:os'
import {
  dirname,
  isAbsolute,
  join,
  relative,
} from 'node:path'

import { compilePortableBytecode } from './portable-bytecode.js'
import {
  runPortableExecutorBenchmark,
} from './portable-executor-equivalence.js'
import {
  nativeRuntimeAbiCoreCSource,
  nativeRuntimeAbiDriverCSource,
  nativeRuntimeAbiHeaderCSource,
} from './native-runtime-abi.js'
import {
  createMinimalStdNativeBundle,
  minimalStdNativeCoreCSource,
  minimalStdNativeHeaderCSource,
  minimalStdNativePackageIndex,
} from './minimal-std-native.js'
import {
  standaloneMinimalStdCSource,
} from './standalone-minimal-std.js'
import {
  standalonePortableVmCSource,
} from './standalone-portable-vm.js'
import {
  standaloneFaultHostCSource,
} from './standalone-fault-host-boundary.js'
import {
  standaloneTaskLifecycleCSource,
} from './standalone-task-lifecycle-core.js'

export const PORTABLE_RUNTIME_PACKAGE_SCHEMA =
  're.portable-runtime-package@0.1.0'
export const PORTABLE_RUNTIME_PACKAGE_MANIFEST_SCHEMA =
  're.portable-runtime-package-manifest@0.1.0'
export const PORTABLE_RUNTIME_PACKAGE_POLICY_SCHEMA =
  're.portable-runtime-package-policy@0.1.0'
export const PORTABLE_RUNTIME_PACKAGE_CONFORMANCE_SCHEMA =
  're.portable-runtime-package-conformance@0.1.0'
export const PORTABLE_RUNTIME_PACKAGE_CONFORMANCE_REPORT_SCHEMA =
  're.portable-runtime-package-conformance-report@0.1.0'
export const PORTABLE_RUNTIME_PACKAGE_PROFILE =
  're.portable-runtime-package@0.1.0'

const ARCHIVE_FIELDS = ['entries', 'manifest', 'package_digest', 'schema']
const ARCHIVE_ENTRY_FIELDS = ['content_base64', 'kind', 'mode', 'path']
const AUTHORITY_FIELDS = [
  'bundle_digest',
  'llvm_aot_evidence_digest',
  'llvm_aot_stable_digest',
  'minimal_std_abi_report_digest',
  'minimal_std_native_bundle_digest',
  'portable_runtime_abi_report_digest',
  'portable_vm_report_digest',
  'portable_vm_std_report_digest',
  'release_lock_digest',
  'toolchain_digest',
]
const CONFORMANCE_ENTRY_FIELDS = [
  'artifact_digest',
  'expected_execution',
  'id',
  'llvm_source_digest',
  'request_digest',
  'source_digest',
  'source_path',
]
const CONFORMANCE_FIELDS = [
  'core_digest',
  'entrypoint',
  'schema',
  'workloads',
]
const MANIFEST_ENTRY_FIELDS = ['digest', 'mode', 'path', 'size']
const MANIFEST_FIELDS = [
  'authorities',
  'conformance_entry',
  'entries',
  'format',
  'manifest_digest',
  'package',
  'pending',
  'policy_digest',
  'profile',
  'schema',
  'target',
  'tree_digest',
]
const POLICY_FIELDS = [
  'conformance_entry',
  'package',
  'pending',
  'schema',
  'static_files',
  'target',
]
const POLICY_PACKAGE_FIELDS = ['name', 'version']
const POLICY_STATIC_FILE_FIELDS = ['archive_path', 'source_path']
const PROVENANCE_FIELDS = [
  'architecture',
  'compiler_digest',
  'compiler_path',
  'compiler_version_digest',
  'environment_id',
  'host_identity_digest',
  'measurement_source',
  'operating_system',
  'runner_id',
  'synthetic',
  'target_triple',
]
const REPORT_FIELDS = [
  'package_digest',
  'profile',
  'provenance',
  'report_digest',
  'schema',
  'status',
  'target_triple',
  'workloads',
]
const REPORT_WORKLOAD_FIELDS = [
  'driver_digest',
  'executable_digest',
  'execution',
  'id',
  'stdout_digest',
  'workload_digest',
]
const TARGET_FIELDS = ['candidate', 'status', 'target_triple']
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const PACKAGE_FORMAT = 're.canonical-json-source-archive@0.1.0'
const ENTRY_MODE = '0644'
const ENTRY_KIND = 'file'
const PRIVATE_PATH = /(?:\/Users\/|\/home\/|\/private\/var\/folders\/|\/tmp\/)/u

export async function createPortableRuntimePackage({
  bundle,
  llvm_evidence,
  loadGraph,
  minimal_std_abi,
  minimal_std_native,
  policy,
  portable_runtime_abi,
  portable_vm,
  portable_vm_std,
  readSource,
  release_lock_digest,
  task_corpus,
  toolchain_digest,
} = {}) {
  try {
    validateCreateInputs({
      bundle,
      llvm_evidence,
      loadGraph,
      minimal_std_abi,
      minimal_std_native,
      policy,
      portable_runtime_abi,
      portable_vm,
      portable_vm_std,
      readSource,
      release_lock_digest,
      task_corpus,
      toolchain_digest,
    })
    const reference = await runPortableExecutorBenchmark(bundle, { loadGraph })
    if (!reference.ok) return reference
    const referenceWorkloads = reference.value.candidates[0].workloads
    const llvmWorkloads = llvm_evidence.workloads
    if (!Array.isArray(llvmWorkloads)
      || llvmWorkloads.length !== bundle.cases.length) {
      fail('portable-runtime-package-llvm-workload-set-mismatch')
    }

    const generatedDrivers = []
    const workloads = []
    for (let index = 0; index < bundle.cases.length; index += 1) {
      const entry = bundle.cases[index]
      const graph = await loadGraph(entry)
      if (!plainObject(graph) || graph.graph_revision !== entry.graph_revision) {
        fail('portable-runtime-package-graph-authority-mismatch')
      }
      const compiled = compilePortableBytecode(graph)
      if (!compiled.ok) return compiled
      const referenceWorkload = referenceWorkloads[index]
      const llvmWorkload = llvmWorkloads[index]
      const expectedExecution = executionFromReference(referenceWorkload)
      if (!plainObject(llvmWorkload)
        || llvmWorkload.id !== entry.id
        || llvmWorkload.artifact_digest !== compiled.value.artifact_digest
        || llvmWorkload.request_digest !== referenceWorkload.request.request_digest
        || !DIGEST.test(llvmWorkload.source_digest)
        || !canonicalEqual(llvmWorkload.execution, expectedExecution)) {
        fail('portable-runtime-package-llvm-authority-mismatch')
      }
      const sourcePath = `conformance/cases/${String(index).padStart(2, '0')}-${safeName(entry.id)}.c`
      const source = portableRuntimeDriverCSource(
        compiled.value,
        entry.invocations,
      )
      const sourceDigest = digestBytes(Buffer.from(source, 'utf8'))
      generatedDrivers.push(createArchiveEntry(sourcePath, source))
      workloads.push({
        artifact_digest: compiled.value.artifact_digest,
        expected_execution: expectedExecution,
        id: entry.id,
        llvm_source_digest: llvmWorkload.source_digest,
        request_digest: referenceWorkload.request.request_digest,
        source_digest: sourceDigest,
        source_path: sourcePath,
      })
    }

    const conformance = {
      core_digest: digestBytes(Buffer.from(portableRuntimeCoreCSource(), 'utf8')),
      entrypoint: policy.conformance_entry,
      schema: PORTABLE_RUNTIME_PACKAGE_CONFORMANCE_SCHEMA,
      workloads,
    }
    const taskReference = portable_runtime_abi.domains.find(
      ({ id }) => id === 'task-lifecycle',
    )?.report
    if (!plainObject(taskReference)
      || taskReference.schema !== 're.task-runtime-lifecycle-report@0.1.0'
      || !Array.isArray(taskReference.workloads)
      || taskReference.workloads.length !== task_corpus.scenarios.length) {
      fail('portable-runtime-package-native-runtime-authority-invalid')
    }
    const nativeDrivers = []
    const nativeWorkloads = []
    for (let index = 0; index < task_corpus.scenarios.length; index += 1) {
      const scenario = task_corpus.scenarios[index]
      const workload = taskReference.workloads[index]
      const sourcePath = `conformance/native/${String(index).padStart(2, '0')}-${safeName(scenario.id)}.c`
      const source = nativeRuntimeAbiDriverCSource({ scenario, workload })
      const sourceDigest = digestBytes(Buffer.from(source, 'utf8'))
      nativeDrivers.push(createArchiveEntry(sourcePath, source))
      nativeWorkloads.push({
        id: scenario.id,
        request_digest: workload.request.request_digest,
        scenario_kind: scenario.kind,
        source_digest: sourceDigest,
        source_path: sourcePath,
      })
    }
    const nativeConformance = {
      core_digest: digestBytes(
        Buffer.from(nativeRuntimeAbiCoreCSource(), 'utf8'),
      ),
      header_digest: digestBytes(
        Buffer.from(nativeRuntimeAbiHeaderCSource(), 'utf8'),
      ),
      profile: 're.native-runtime-abi@0.1.0',
      reference_report_digest: taskReference.report_digest,
      schema: 're.native-runtime-abi-package-sources@0.1.0',
      workloads: nativeWorkloads,
    }
    const minimalStdNativeResult = createMinimalStdNativeBundle({
      abi: minimal_std_abi,
      corpus: minimal_std_native,
    })
    if (!minimalStdNativeResult.ok) return minimalStdNativeResult
    const minimalStdNative = minimalStdNativeResult.value
    const staticEntries = []
    for (const entry of policy.static_files) {
      const bytes = await readSource(entry.source_path)
      if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
        fail('portable-runtime-package-source-bytes-invalid')
      }
      staticEntries.push(createArchiveEntry(entry.archive_path, bytes))
    }
    const entries = [
      ...staticEntries,
      createArchiveEntry('NOTICE.md', portableRuntimeNotice(policy)),
      createArchiveEntry('conformance/index.json', canonicalJson(conformance)),
      createArchiveEntry(
        'conformance/native/index.json',
        canonicalJson(nativeConformance),
      ),
      createArchiveEntry(
        'conformance/minimal-std/index.json',
        canonicalJson(minimalStdNativePackageIndex(minimalStdNative)),
      ),
      createArchiveEntry(
        'runtime/minimal_std.c',
        minimalStdNativeCoreCSource(),
      ),
      createArchiveEntry(
        'runtime/minimal_std.h',
        minimalStdNativeHeaderCSource(),
      ),
      createArchiveEntry(
        'runtime/standalone_portable_vm.c',
        standalonePortableVmCSource(),
      ),
      createArchiveEntry(
        'runtime/standalone_minimal_std.c',
        standaloneMinimalStdCSource(),
      ),
      createArchiveEntry(
        'runtime/standalone_fault_host.c',
        standaloneFaultHostCSource(),
      ),
      createArchiveEntry(
        'runtime/standalone_task_lifecycle.c',
        standaloneTaskLifecycleCSource(taskReference),
      ),
      createArchiveEntry(
        'runtime/native_runtime_abi.c',
        nativeRuntimeAbiCoreCSource(),
      ),
      createArchiveEntry(
        'runtime/native_runtime_abi.h',
        nativeRuntimeAbiHeaderCSource(),
      ),
      createArchiveEntry('runtime/portable_runtime.c', portableRuntimeCoreCSource()),
      createArchiveEntry('runtime/portable_runtime.h', portableRuntimeHeaderCSource()),
      ...generatedDrivers,
      ...nativeDrivers,
      ...minimalStdNative.workloads.map((workload) => createArchiveEntry(
        `conformance/minimal-std/${safeName(workload.id)}.c`,
        workload.source,
      )),
    ].sort(({ path: left }, { path: right }) => left.localeCompare(right, 'en'))
    const manifestEntries = entries.map((entry) => archiveEntryManifest(entry))
    const authorities = createAuthorities({
      bundle,
      llvm_evidence,
      minimal_std_abi,
      portable_runtime_abi,
      portable_vm,
      portable_vm_std,
      minimal_std_native_bundle: minimalStdNative,
      release_lock_digest,
      toolchain_digest,
    })
    const manifest = {
      authorities,
      conformance_entry: policy.conformance_entry,
      entries: manifestEntries,
      format: PACKAGE_FORMAT,
      package: structuredClone(policy.package),
      pending: structuredClone(policy.pending),
      policy_digest: digestValue(policy),
      profile: PORTABLE_RUNTIME_PACKAGE_PROFILE,
      schema: PORTABLE_RUNTIME_PACKAGE_MANIFEST_SCHEMA,
      target: structuredClone(policy.target),
      tree_digest: portableRuntimePackageTreeDigest(manifestEntries),
    }
    manifest.manifest_digest = portableRuntimePackageManifestDigest(manifest)
    const archive = {
      entries,
      manifest,
      schema: PORTABLE_RUNTIME_PACKAGE_SCHEMA,
    }
    archive.package_digest = portableRuntimePackageDigest(archive)
    const structural = validatePortableRuntimePackageArchive(archive)
    return structural.ok ? { ok: true, value: archive } : structural
  } catch (error) {
    return rejected(error?.code ?? 'portable-runtime-package-build-failed')
  }
}

export async function verifyPortableRuntimePackage(archive, inputs = {}) {
  const structural = validatePortableRuntimePackageArchive(archive)
  if (!structural.ok) return structural
  const expected = await createPortableRuntimePackage(inputs)
  if (!expected.ok) return expected

  if (!canonicalEqual(archive.manifest.target, expected.value.manifest.target)) {
    return rejected('portable-runtime-package-target-policy-mismatch')
  }
  if (!canonicalEqual(archive.manifest.pending, expected.value.manifest.pending)
    || archive.manifest.policy_digest !== expected.value.manifest.policy_digest
    || !canonicalEqual(archive.manifest.package, expected.value.manifest.package)
    || archive.manifest.conformance_entry
      !== expected.value.manifest.conformance_entry) {
    return rejected('portable-runtime-package-policy-mismatch')
  }
  if (!canonicalEqual(
    archive.manifest.authorities,
    expected.value.manifest.authorities,
  )) {
    return rejected('portable-runtime-package-authority-mismatch')
  }
  if (!canonicalEqual(archive.manifest.entries, expected.value.manifest.entries)
    || !canonicalEqual(archive.entries, expected.value.entries)) {
    return rejected('portable-runtime-package-source-authority-mismatch')
  }
  if (!canonicalEqual(archive.manifest, expected.value.manifest)
    || archive.package_digest !== expected.value.package_digest) {
    return rejected('portable-runtime-package-archive-authority-mismatch')
  }
  return { ok: true }
}

export async function extractPortableRuntimePackage(archive, {
  destination,
  inputs,
} = {}) {
  try {
    if (!isAbsolute(destination)) {
      fail('portable-runtime-package-extract-destination-invalid')
    }
    const verified = await verifyPortableRuntimePackage(archive, inputs)
    if (!verified.ok) return verified
    await mkdir(destination, { recursive: true })
    if ((await lstat(destination)).isSymbolicLink()) {
      fail('portable-runtime-package-extract-symlink')
    }
    for (const entry of archive.entries) {
      const target = safeDestination(destination, entry.path)
      await ensureDirectoryBoundary(destination, dirname(target))
      try {
        await lstat(target)
        fail('portable-runtime-package-extract-path-exists')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      await writeFile(target, Buffer.from(entry.content_base64, 'base64'), {
        mode: Number.parseInt(entry.mode, 8),
      })
      const metadata = await lstat(target)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        fail('portable-runtime-package-extract-file-invalid')
      }
    }
    return {
      ok: true,
      value: {
        destination,
        package_digest: archive.package_digest,
      },
    }
  } catch (error) {
    return rejected(error?.code ?? 'portable-runtime-package-extract-failed')
  }
}

export async function runPortableRuntimePackageConformance({
  compiler_path,
  package: archive,
  target_triple,
  ...inputs
} = {}) {
  let root = null
  try {
    if (!isAbsolute(compiler_path) || typeof target_triple !== 'string'
      || target_triple.length === 0) {
      fail('portable-runtime-package-conformance-input-invalid')
    }
    const verified = await verifyPortableRuntimePackage(archive, inputs)
    if (!verified.ok) return verified
    if (target_triple !== archive.manifest.target.target_triple) {
      fail('portable-runtime-package-conformance-target-mismatch')
    }
    const conformance = packageConformanceIndex(archive)
    root = await mkdtemp(join(tmpdir(), 're-portable-runtime-package-'))
    const extracted = await extractPortableRuntimePackage(archive, {
      destination: root,
      inputs,
    })
    if (!extracted.ok) return extracted
    const provenance = await currentCompilerProvenance({
      compiler_path,
      target_triple,
    })
    const buildDirectory = join(root, '.build')
    await mkdir(buildDirectory)
    const workloads = []
    for (let index = 0; index < conformance.workloads.length; index += 1) {
      const expected = conformance.workloads[index]
      const executablePath = join(buildDirectory, `${index}.bin`)
      const built = spawnSync(
        compiler_path,
        [
          '-O2',
          '-std=c11',
          '-target',
          target_triple,
          '-I',
          join(root, 'runtime'),
          join(root, 'runtime/portable_runtime.c'),
          join(root, expected.source_path),
          '-o',
          executablePath,
        ],
        { cwd: root, encoding: 'utf8', shell: false },
      )
      if (built.error?.code === 'ENOENT') {
        fail('portable-runtime-package-compiler-missing')
      }
      if (built.error || built.status !== 0) {
        fail('portable-runtime-package-conformance-compile-failed')
      }
      const metadata = await stat(executablePath)
      if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
        fail('portable-runtime-package-conformance-executable-missing')
      }
      const executed = spawnSync(executablePath, [], {
        cwd: root,
        encoding: 'utf8',
        shell: false,
      })
      if (executed.error || executed.status !== 0 || executed.stderr !== '') {
        fail('portable-runtime-package-conformance-execution-failed')
      }
      let execution
      try {
        execution = JSON.parse(executed.stdout)
      } catch {
        fail('portable-runtime-package-conformance-stdout-invalid')
      }
      if (!canonicalEqual(execution, expected.expected_execution)
        || executed.stdout !== `${JSON.stringify(expected.expected_execution)}\n`) {
        fail('portable-runtime-package-conformance-semantic-mismatch')
      }
      const workload = {
        driver_digest: expected.source_digest,
        executable_digest: digestBytes(await readFile(executablePath)),
        execution,
        id: expected.id,
        stdout_digest: digestBytes(Buffer.from(executed.stdout, 'utf8')),
      }
      workload.workload_digest = packageConformanceWorkloadDigest(workload)
      workloads.push(workload)
    }
    const report = {
      package_digest: archive.package_digest,
      profile: PORTABLE_RUNTIME_PACKAGE_PROFILE,
      provenance,
      schema: PORTABLE_RUNTIME_PACKAGE_CONFORMANCE_REPORT_SCHEMA,
      status: 'measured',
      target_triple,
      workloads,
    }
    report.report_digest = portableRuntimePackageConformanceDigest(report)
    const reportVerified = await verifyPortableRuntimePackageConformance(report, {
      compiler_path,
      package: archive,
      target_triple,
      ...inputs,
    })
    return reportVerified.ok ? { ok: true, value: report } : reportVerified
  } catch (error) {
    return rejected(error?.code ?? 'portable-runtime-package-conformance-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function verifyPortableRuntimePackageConformance(report, {
  compiler_path,
  package: archive,
  target_triple,
  ...inputs
} = {}) {
  let root = null
  try {
    const verified = await verifyPortableRuntimePackage(archive, inputs)
    if (!verified.ok) return verified
    if (!isAbsolute(compiler_path)
      || typeof target_triple !== 'string'
      || target_triple !== archive.manifest.target.target_triple) {
      fail('portable-runtime-package-conformance-input-invalid')
    }
    validateConformanceReport(report)
    if (report.package_digest !== archive.package_digest
      || report.target_triple !== target_triple) {
      fail('portable-runtime-package-conformance-authority-mismatch')
    }
    const provenance = await currentCompilerProvenance({
      compiler_path,
      target_triple,
    })
    if (!canonicalEqual(report.provenance, provenance)) {
      fail('portable-runtime-package-conformance-compiler-mismatch')
    }
    const conformance = packageConformanceIndex(archive)
    if (report.workloads.length !== conformance.workloads.length
      || !canonicalEqual(
        report.workloads.map(({ id }) => id),
        conformance.workloads.map(({ id }) => id),
      )) {
      fail('portable-runtime-package-conformance-workload-set-mismatch')
    }
    root = await mkdtemp(join(tmpdir(), 're-portable-runtime-verify-'))
    const extracted = await extractPortableRuntimePackage(archive, {
      destination: root,
      inputs,
    })
    if (!extracted.ok) return extracted
    const buildDirectory = join(root, '.verify-build')
    await mkdir(buildDirectory)
    for (let index = 0; index < report.workloads.length; index += 1) {
      const actual = report.workloads[index]
      const expected = conformance.workloads[index]
      if (actual.driver_digest !== expected.source_digest
        || !canonicalEqual(actual.execution, expected.expected_execution)
        || actual.stdout_digest !== digestBytes(
          Buffer.from(`${JSON.stringify(expected.expected_execution)}\n`, 'utf8'),
        )
        || actual.workload_digest !== packageConformanceWorkloadDigest(actual)) {
        fail('portable-runtime-package-conformance-workload-authority-mismatch')
      }
      const executablePath = join(buildDirectory, `${index}.bin`)
      const built = spawnSync(
        compiler_path,
        [
          '-O2',
          '-std=c11',
          '-target',
          target_triple,
          '-I',
          join(root, 'runtime'),
          join(root, 'runtime/portable_runtime.c'),
          join(root, expected.source_path),
          '-o',
          executablePath,
        ],
        { cwd: root, encoding: 'utf8', shell: false },
      )
      if (built.error?.code === 'ENOENT') {
        fail('portable-runtime-package-compiler-missing')
      }
      if (built.error || built.status !== 0) {
        fail('portable-runtime-package-conformance-compile-failed')
      }
      if (actual.executable_digest
        !== digestBytes(await readFile(executablePath))) {
        fail('portable-runtime-package-conformance-executable-mismatch')
      }
    }
    if (report.report_digest !== portableRuntimePackageConformanceDigest(report)) {
      fail('portable-runtime-package-conformance-report-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'portable-runtime-package-conformance-invalid')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export function portableRuntimePackageManifestDigest(manifest) {
  if (!plainObject(manifest)) {
    throw new TypeError('invalid portable runtime package manifest')
  }
  const { manifest_digest: ignored, ...content } = manifest
  return digestValue(content)
}

export function portableRuntimePackageTreeDigest(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('invalid portable runtime package tree')
  }
  return digestValue(entries)
}

export function portableRuntimePackageDigest(archive) {
  if (!plainObject(archive)) {
    throw new TypeError('invalid portable runtime package archive')
  }
  const { package_digest: ignored, ...content } = archive
  return digestValue(content)
}

export function portableRuntimePackageConformanceDigest(report) {
  if (!plainObject(report)) {
    throw new TypeError('invalid portable runtime package conformance report')
  }
  const { report_digest: ignored, ...content } = report
  return digestValue(content)
}

export function portableRuntimeHeaderCSource() {
  return [
    '#ifndef REVIA_PORTABLE_RUNTIME_H',
    '#define REVIA_PORTABLE_RUNTIME_H',
    '',
    'typedef struct {',
    '  const char *artifact_arguments_json;',
    '  const char *artifact_digest_json;',
    '  const char *artifact_instance_json;',
    '  const char *artifact_invocation_json;',
    '  const char *artifact_member_json;',
    '  const char *graph_revision_json;',
    '  int err_exit;',
    '  int err_pc;',
    '  int ok_exit;',
    '  int ok_pc;',
    '  int transcript_result;',
    '  const char *transcript_arguments_json;',
    '  const char *transcript_instance_json;',
    '  const char *transcript_invocation_json;',
    '  const char *transcript_member_json;',
    '} revia_portable_program;',
    '',
    'int revia_portable_execute(const revia_portable_program *program);',
    '',
    '#endif',
    '',
  ].join('\n')
}

export function portableRuntimeCoreCSource() {
  return [
    '#include "portable_runtime.h"',
    '',
    '#include <stdio.h>',
    '#include <string.h>',
    '',
    'int revia_portable_execute(const revia_portable_program *program) {',
    '  if (program == NULL) return 72;',
    '  if (strcmp(program->artifact_instance_json, program->transcript_instance_json) != 0',
    '      || strcmp(program->artifact_member_json, program->transcript_member_json) != 0',
    '      || strcmp(program->artifact_invocation_json, program->transcript_invocation_json) != 0',
    '      || strcmp(program->artifact_arguments_json, program->transcript_arguments_json) != 0) return 70;',
    '  int pc = 0;',
    '  int exit_code = -1;',
    '  const char *invocation_outcome_json = NULL;',
    '  for (;;) {',
    '    switch (pc) {',
    '      case 0: invocation_outcome_json = program->transcript_result == 1 ? "\\"ok\\"" : "\\"err\\""; pc = 1; break;',
    '      case 1: pc = program->transcript_result == 1 ? program->ok_pc : program->err_pc; break;',
    '      default:',
    '        if (pc == program->ok_pc) { exit_code = program->ok_exit; goto complete; }',
    '        if (pc == program->err_pc) { exit_code = program->err_exit; goto complete; }',
    '        return 71;',
    '    }',
    '  }',
    'complete:',
    '  printf("{\\"artifact_digest\\":%s,\\"graph_revision\\":%s,\\"invocations\\":[{\\"instance\\":%s,\\"invocation_id\\":%s,\\"member\\":%s,\\"outcome\\":%s}],\\"outcome\\":{\\"code\\":%d,\\"type\\":\\"process.status\\"}}\\n",',
    '    program->artifact_digest_json,',
    '    program->graph_revision_json,',
    '    program->artifact_instance_json,',
    '    program->artifact_invocation_json,',
    '    program->artifact_member_json,',
    '    invocation_outcome_json,',
    '    exit_code);',
    '  return 0;',
    '}',
    '',
  ].join('\n')
}

export function portableRuntimeDriverCSource(artifact, invocations) {
  if (!plainObject(artifact)
    || !Array.isArray(artifact.instructions)
    || artifact.instructions.length !== 4
    || !Array.isArray(invocations)
    || invocations.length !== 1) {
    throw codedError('portable-runtime-package-driver-input-invalid')
  }
  const [invoke, branch, okExit, errExit] = artifact.instructions
  if (invoke.op !== 'invoke-capability'
    || branch.op !== 'branch-result'
    || okExit.op !== 'process-exit'
    || errExit.op !== 'process-exit') {
    throw codedError('portable-runtime-package-opcode-unsupported')
  }
  const transcript = invocations[0]
  const responseKind = transcript?.response?.kind === 'value'
    ? transcript.response.value?.kind
    : null
  if (!['err', 'ok'].includes(responseKind)) {
    throw codedError('portable-runtime-package-transcript-response-unsupported')
  }
  const artifactArguments = Object.fromEntries(
    invoke.arguments.map(({ literal, name }) => [
      name,
      encodedLiteral(artifact.literals[literal]),
    ]),
  )
  const transcriptArguments = normalizeTranscriptArguments(
    transcript.instance,
    transcript.member,
    transcript.arguments,
  )
  const values = [
    ['artifact_arguments_json', canonicalJson(artifactArguments)],
    ['artifact_digest_json', JSON.stringify(artifact.artifact_digest)],
    ['artifact_instance_json', JSON.stringify(invoke.instance)],
    ['artifact_invocation_json', JSON.stringify(invoke.invocation_id)],
    ['artifact_member_json', JSON.stringify(invoke.member)],
    ['graph_revision_json', JSON.stringify(artifact.graph_revision)],
    ['err_exit', exitCode(artifact.literals[errExit.code_literal])],
    ['err_pc', branch.err],
    ['ok_exit', exitCode(artifact.literals[okExit.code_literal])],
    ['ok_pc', branch.ok],
    ['transcript_result', responseKind === 'ok' ? 1 : 2],
    ['transcript_arguments_json', canonicalJson(transcriptArguments)],
    ['transcript_instance_json', JSON.stringify(transcript.instance)],
    ['transcript_invocation_json', JSON.stringify(transcript.invocation_id)],
    ['transcript_member_json', JSON.stringify(transcript.member)],
  ]
  return [
    '#include "portable_runtime.h"',
    '',
    'int main(void) {',
    '  static const revia_portable_program program = {',
    ...values.map(([field, value]) => (
      `    .${field} = ${typeof value === 'number' ? value : cString(value)},`
    )),
    '  };',
    '  return revia_portable_execute(&program);',
    '}',
    '',
  ].join('\n')
}

function validateCreateInputs({
  bundle,
  llvm_evidence,
  loadGraph,
  minimal_std_abi,
  minimal_std_native,
  policy,
  portable_runtime_abi,
  portable_vm,
  portable_vm_std,
  readSource,
  release_lock_digest,
  task_corpus,
  toolchain_digest,
}) {
  validatePolicy(policy)
  if (!plainObject(bundle) || !Array.isArray(bundle.cases)
    || bundle.cases.length === 0
    || typeof loadGraph !== 'function'
    || typeof readSource !== 'function'
    || !plainObject(minimal_std_native)
    || minimal_std_native.schema !== 're.minimal-std-native-corpus@0.1.0'
    || !Array.isArray(minimal_std_native.cases)
    || minimal_std_native.cases.length !== 12
    || !plainObject(task_corpus)
    || task_corpus.schema !== 're.task-runtime-lifecycle-corpus@0.1.0'
    || !Array.isArray(task_corpus.scenarios)
    || !DIGEST.test(release_lock_digest)
    || !DIGEST.test(toolchain_digest)) {
    fail('portable-runtime-package-input-invalid')
  }
  if (!plainObject(llvm_evidence)
    || llvm_evidence.schema !== 're.llvm-aot-external-evidence@0.1.0'
    || llvm_evidence.candidate !== 'aot-llvm'
    || llvm_evidence.status !== 'measured'
    || llvm_evidence.release_lock_digest !== release_lock_digest
    || llvm_evidence.toolchain_digest !== toolchain_digest
    || llvm_evidence.bundle_digest !== digestValue(bundle)
    || !DIGEST.test(llvm_evidence.evidence_digest)
    || !DIGEST.test(llvm_evidence.stable_digest)) {
    fail('portable-runtime-package-llvm-authority-invalid')
  }
  validateReportAuthority(
    minimal_std_abi,
    're.minimal-std-abi-report@0.1.0',
    'portable-runtime-package-minimal-std-authority-invalid',
  )
  validateReportAuthority(
    portable_runtime_abi,
    're.portable-runtime-abi-report@0.1.0',
    'portable-runtime-package-runtime-abi-authority-invalid',
  )
  validateReportAuthority(
    portable_vm,
    're.portable-vm-conformance@0.1.0',
    'portable-runtime-package-vm-authority-invalid',
  )
  validateReportAuthority(
    portable_vm_std,
    're.portable-vm-std-conformance@0.1.0',
    'portable-runtime-package-vm-std-authority-invalid',
  )
}

function validatePortableRuntimePackageArchive(archive) {
  try {
    if (!plainObject(archive)
      || !exactShape(archive, ARCHIVE_FIELDS)
      || archive.schema !== PORTABLE_RUNTIME_PACKAGE_SCHEMA
      || !DIGEST.test(archive.package_digest)
      || !Array.isArray(archive.entries)) {
      fail('portable-runtime-package-archive-invalid')
    }
    validateManifest(archive.manifest)
    if (archive.package_digest !== portableRuntimePackageDigest(archive)) {
      fail('portable-runtime-package-digest-mismatch')
    }
    if (archive.entries.length !== archive.manifest.entries.length) {
      fail('portable-runtime-package-entry-set-mismatch')
    }
    const paths = []
    for (let index = 0; index < archive.entries.length; index += 1) {
      const entry = archive.entries[index]
      const manifestEntry = archive.manifest.entries[index]
      if (!plainObject(entry)
        || !exactShape(entry, ARCHIVE_ENTRY_FIELDS)
        || entry.kind !== ENTRY_KIND
        || entry.mode !== ENTRY_MODE
        || !validArchivePath(entry.path)
        || typeof entry.content_base64 !== 'string'
        || !BASE64.test(entry.content_base64)
        || Buffer.from(entry.content_base64, 'base64').toString('base64')
          !== entry.content_base64) {
        fail(entry?.kind !== ENTRY_KIND
          ? 'portable-runtime-package-entry-kind-invalid'
          : 'portable-runtime-package-entry-path-invalid')
      }
      const bytes = Buffer.from(entry.content_base64, 'base64')
      if (PRIVATE_PATH.test(bytes.toString('utf8'))) {
        fail('portable-runtime-package-private-path')
      }
      const expected = {
        digest: digestBytes(bytes),
        mode: entry.mode,
        path: entry.path,
        size: bytes.length,
      }
      if (!canonicalEqual(manifestEntry, expected)) {
        fail('portable-runtime-package-entry-digest-mismatch')
      }
      paths.push(entry.path)
    }
    if (!canonicalEqual(paths, [...paths].sort((left, right) => (
      left.localeCompare(right, 'en')
    ))) || new Set(paths).size !== paths.length) {
      fail('portable-runtime-package-entry-order-mismatch')
    }
    if (archive.manifest.tree_digest
      !== portableRuntimePackageTreeDigest(archive.manifest.entries)) {
      fail('portable-runtime-package-tree-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'portable-runtime-package-archive-invalid')
  }
}

function validateManifest(manifest) {
  if (!plainObject(manifest)
    || !exactShape(manifest, MANIFEST_FIELDS)
    || manifest.schema !== PORTABLE_RUNTIME_PACKAGE_MANIFEST_SCHEMA
    || manifest.profile !== PORTABLE_RUNTIME_PACKAGE_PROFILE
    || manifest.format !== PACKAGE_FORMAT
    || !plainObject(manifest.package)
    || !exactShape(manifest.package, POLICY_PACKAGE_FIELDS)
    || typeof manifest.package.name !== 'string'
    || manifest.package.name.length === 0
    || typeof manifest.package.version !== 'string'
    || manifest.package.version.length === 0
    || !DIGEST.test(manifest.policy_digest)
    || !DIGEST.test(manifest.tree_digest)
    || !DIGEST.test(manifest.manifest_digest)
    || !DIGEST.test(manifest.conformance_entry === undefined ? '' : digestValue(
      manifest.conformance_entry,
    ))
    || !Array.isArray(manifest.entries)
    || !Array.isArray(manifest.pending)) {
    fail('portable-runtime-package-manifest-invalid')
  }
  if (!validArchivePath(manifest.conformance_entry)) {
    fail('portable-runtime-package-manifest-invalid')
  }
  if (!plainObject(manifest.authorities)
    || !exactShape(manifest.authorities, AUTHORITY_FIELDS)
    || !AUTHORITY_FIELDS.every((field) => DIGEST.test(manifest.authorities[field]))) {
    fail('portable-runtime-package-authorities-invalid')
  }
  validateTarget(manifest.target)
  validatePending(manifest.pending)
  for (const entry of manifest.entries) {
    if (!plainObject(entry)
      || !exactShape(entry, MANIFEST_ENTRY_FIELDS)
      || !DIGEST.test(entry.digest)
      || entry.mode !== ENTRY_MODE
      || !validArchivePath(entry.path)
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0) {
      fail('portable-runtime-package-manifest-entry-invalid')
    }
  }
  if (manifest.manifest_digest !== portableRuntimePackageManifestDigest(manifest)) {
    fail('portable-runtime-package-manifest-digest-mismatch')
  }
}

function validatePolicy(policy) {
  if (!plainObject(policy)
    || !exactShape(policy, POLICY_FIELDS)
    || policy.schema !== PORTABLE_RUNTIME_PACKAGE_POLICY_SCHEMA
    || !plainObject(policy.package)
    || !exactShape(policy.package, POLICY_PACKAGE_FIELDS)
    || typeof policy.package.name !== 'string'
    || policy.package.name.length === 0
    || typeof policy.package.version !== 'string'
    || policy.package.version.length === 0
    || !Array.isArray(policy.static_files)
    || policy.static_files.length === 0
    || !validArchivePath(policy.conformance_entry)) {
    fail('portable-runtime-package-policy-invalid')
  }
  const archivePaths = []
  for (const entry of policy.static_files) {
    if (!plainObject(entry)
      || !exactShape(entry, POLICY_STATIC_FILE_FIELDS)
      || !validArchivePath(entry.archive_path)
      || !validSourcePath(entry.source_path)) {
      fail('portable-runtime-package-policy-static-file-invalid')
    }
    archivePaths.push(entry.archive_path)
  }
  if (new Set(archivePaths).size !== archivePaths.length) {
    fail('portable-runtime-package-policy-static-file-duplicate')
  }
  validateTarget(policy.target)
  validatePending(policy.pending)
}

function validateConformanceReport(report) {
  if (!plainObject(report)
    || !exactShape(report, REPORT_FIELDS)
    || report.schema !== PORTABLE_RUNTIME_PACKAGE_CONFORMANCE_REPORT_SCHEMA
    || report.profile !== PORTABLE_RUNTIME_PACKAGE_PROFILE
    || report.status !== 'measured'
    || !DIGEST.test(report.package_digest)
    || !DIGEST.test(report.report_digest)
    || typeof report.target_triple !== 'string'
    || report.target_triple.length === 0
    || !Array.isArray(report.workloads)) {
    fail('portable-runtime-package-conformance-report-invalid')
  }
  validateCompilerProvenance(report.provenance)
  for (const workload of report.workloads) {
    if (!plainObject(workload)
      || !exactShape(workload, REPORT_WORKLOAD_FIELDS)
      || typeof workload.id !== 'string'
      || !DIGEST.test(workload.driver_digest)
      || !DIGEST.test(workload.executable_digest)
      || !DIGEST.test(workload.stdout_digest)
      || !DIGEST.test(workload.workload_digest)
      || !validExecution(workload.execution)) {
      fail('portable-runtime-package-conformance-workload-invalid')
    }
  }
}

function createAuthorities({
  bundle,
  llvm_evidence,
  minimal_std_abi,
  minimal_std_native_bundle,
  portable_runtime_abi,
  portable_vm,
  portable_vm_std,
  release_lock_digest,
  toolchain_digest,
}) {
  return {
    bundle_digest: digestValue(bundle),
    llvm_aot_evidence_digest: llvm_evidence.evidence_digest,
    llvm_aot_stable_digest: llvm_evidence.stable_digest,
    minimal_std_abi_report_digest: minimal_std_abi.report_digest,
    minimal_std_native_bundle_digest: minimal_std_native_bundle.bundle_digest,
    portable_runtime_abi_report_digest: portable_runtime_abi.report_digest,
    portable_vm_report_digest: portable_vm.report_digest,
    portable_vm_std_report_digest: portable_vm_std.report_digest,
    release_lock_digest,
    toolchain_digest,
  }
}

function createArchiveEntry(path, bytes) {
  const content = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes, 'utf8')
  return {
    content_base64: content.toString('base64'),
    kind: ENTRY_KIND,
    mode: ENTRY_MODE,
    path,
  }
}

function archiveEntryManifest(entry) {
  const bytes = Buffer.from(entry.content_base64, 'base64')
  return {
    digest: digestBytes(bytes),
    mode: entry.mode,
    path: entry.path,
    size: bytes.length,
  }
}

function packageConformanceIndex(archive) {
  const entry = archive.entries.find(
    ({ path }) => path === archive.manifest.conformance_entry,
  )
  if (entry === undefined) {
    throw codedError('portable-runtime-package-conformance-entry-missing')
  }
  let index
  try {
    index = JSON.parse(Buffer.from(entry.content_base64, 'base64').toString('utf8'))
  } catch {
    throw codedError('portable-runtime-package-conformance-entry-invalid')
  }
  if (!plainObject(index)
    || !exactShape(index, CONFORMANCE_FIELDS)
    || index.schema !== PORTABLE_RUNTIME_PACKAGE_CONFORMANCE_SCHEMA
    || index.entrypoint !== archive.manifest.conformance_entry
    || !DIGEST.test(index.core_digest)
    || !Array.isArray(index.workloads)) {
    throw codedError('portable-runtime-package-conformance-entry-invalid')
  }
  for (const workload of index.workloads) {
    if (!plainObject(workload)
      || !exactShape(workload, CONFORMANCE_ENTRY_FIELDS)
      || typeof workload.id !== 'string'
      || !DIGEST.test(workload.artifact_digest)
      || !DIGEST.test(workload.request_digest)
      || !DIGEST.test(workload.llvm_source_digest)
      || !DIGEST.test(workload.source_digest)
      || !validArchivePath(workload.source_path)
      || !validExecution(workload.expected_execution)) {
      throw codedError('portable-runtime-package-conformance-workload-invalid')
    }
  }
  if (index.core_digest !== digestBytes(
    Buffer.from(portableRuntimeCoreCSource(), 'utf8'),
  )) {
    throw codedError('portable-runtime-package-conformance-core-mismatch')
  }
  return index
}

async function currentCompilerProvenance({ compiler_path, target_triple }) {
  let compilerBytes
  let metadata
  try {
    compilerBytes = await readFile(compiler_path)
    metadata = await stat(compiler_path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('portable-runtime-package-compiler-missing')
    }
    throw error
  }
  if (!metadata.isFile()) fail('portable-runtime-package-compiler-invalid')
  const version = spawnSync(compiler_path, ['--version'], {
    encoding: 'utf8',
    shell: false,
  })
  if (version.error || version.status !== 0 || version.stdout.length === 0) {
    fail('portable-runtime-package-compiler-version-failed')
  }
  const operatingSystem = platform()
  const architecture = arch()
  const compilerDigest = digestBytes(compilerBytes)
  return {
    architecture,
    compiler_digest: compilerDigest,
    compiler_path,
    compiler_version_digest: digestBytes(Buffer.from(version.stdout, 'utf8')),
    environment_id: `${operatingSystem}-${architecture}-portable-runtime-package`,
    host_identity_digest: digestValue({
      architecture,
      compiler_digest: compilerDigest,
      operating_system: operatingSystem,
      release: release(),
      target_triple,
    }),
    measurement_source: 'runner',
    operating_system: operatingSystem,
    runner_id: PORTABLE_RUNTIME_PACKAGE_PROFILE,
    synthetic: false,
    target_triple,
  }
}

function validateCompilerProvenance(value) {
  if (!plainObject(value)
    || !exactShape(value, PROVENANCE_FIELDS)
    || typeof value.architecture !== 'string'
    || value.architecture.length === 0
    || !DIGEST.test(value.compiler_digest)
    || !isAbsolute(value.compiler_path)
    || !DIGEST.test(value.compiler_version_digest)
    || typeof value.environment_id !== 'string'
    || value.environment_id.length === 0
    || !DIGEST.test(value.host_identity_digest)
    || value.measurement_source !== 'runner'
    || typeof value.operating_system !== 'string'
    || value.operating_system.length === 0
    || value.runner_id !== PORTABLE_RUNTIME_PACKAGE_PROFILE
    || value.synthetic !== false
    || typeof value.target_triple !== 'string'
    || value.target_triple.length === 0) {
    fail('portable-runtime-package-conformance-provenance-invalid')
  }
}

function validateReportAuthority(report, schema, code) {
  if (!plainObject(report)
    || report.schema !== schema
    || !DIGEST.test(report.report_digest)) {
    fail(code)
  }
}

function validateTarget(target) {
  if (!plainObject(target)
    || !exactShape(target, TARGET_FIELDS)
    || typeof target.candidate !== 'string'
    || target.candidate.length === 0
    || typeof target.status !== 'string'
    || target.status.length === 0
    || typeof target.target_triple !== 'string'
    || target.target_triple.length === 0) {
    fail('portable-runtime-package-target-invalid')
  }
}

function validatePending(pending) {
  if (!Array.isArray(pending) || pending.length === 0) {
    fail('portable-runtime-package-pending-invalid')
  }
  const ids = []
  for (const entry of pending) {
    if (!plainObject(entry)
      || !exactShape(entry, ['id', 'reason'])
      || typeof entry.id !== 'string'
      || entry.id.length === 0
      || typeof entry.reason !== 'string'
      || entry.reason.length === 0) {
      fail('portable-runtime-package-pending-invalid')
    }
    ids.push(entry.id)
  }
  if (new Set(ids).size !== ids.length) {
    fail('portable-runtime-package-pending-duplicate')
  }
}

function validArchivePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && !path.includes('\0')
    && path.split('/').every((part) => part.length > 0
      && part !== '.' && part !== '..')
}

function validSourcePath(path) {
  return validArchivePath(path)
    && !path.startsWith('node_modules/')
    && !path.startsWith('scratch/')
}

function safeDestination(root, archivePath) {
  if (!validArchivePath(archivePath)) {
    throw codedError('portable-runtime-package-entry-path-invalid')
  }
  const target = join(root, ...archivePath.split('/'))
  const outside = relative(root, target)
  if (outside === '' || outside.startsWith('..') || isAbsolute(outside)) {
    throw codedError('portable-runtime-package-entry-path-invalid')
  }
  return target
}

async function ensureDirectoryBoundary(root, directory) {
  const suffix = relative(root, directory)
  if (suffix.startsWith('..') || isAbsolute(suffix)) {
    fail('portable-runtime-package-extract-path-invalid')
  }
  let current = root
  for (const part of suffix === '' ? [] : suffix.split('/')) {
    current = join(current, part)
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink()) {
        fail('portable-runtime-package-extract-symlink')
      }
      if (!metadata.isDirectory()) {
        fail('portable-runtime-package-extract-parent-invalid')
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(current)
    }
  }
}

function executionFromReference(workload) {
  return {
    artifact_digest: workload.request.artifact_digest,
    graph_revision: workload.request.graph_revision,
    invocations: structuredClone(workload.result.receipt.invocations),
    outcome: structuredClone(workload.result.outcome),
  }
}

function packageConformanceWorkloadDigest(workload) {
  if (!plainObject(workload)) {
    throw new TypeError('invalid portable runtime package workload')
  }
  const { workload_digest: ignored, ...content } = workload
  return digestValue(content)
}

function normalizeTranscriptArguments(instance, member, arguments_) {
  if (typeof instance !== 'string'
    || typeof member !== 'string'
    || !plainObject(arguments_)) {
    throw codedError('portable-runtime-package-transcript-arguments-invalid')
  }
  return arguments_
}

function encodedLiteral(literal) {
  if (!plainObject(literal) || typeof literal.type !== 'string') {
    throw codedError('portable-runtime-package-literal-invalid')
  }
  return literal.type === 'bytes'
    ? { $bytes: literal.value }
    : literal.value
}

function exitCode(literal) {
  if (!plainObject(literal)
    || literal.type !== 'int'
    || typeof literal.value !== 'string'
    || !/^(?:0|[1-9][0-9]*)$/u.test(literal.value)) {
    throw codedError('portable-runtime-package-exit-invalid')
  }
  const numeric = Number(BigInt(literal.value))
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 255) {
    throw codedError('portable-runtime-package-exit-invalid')
  }
  return numeric
}

function portableRuntimeNotice(policy) {
  return [
    'Revia portable runtime source package.',
    `Package: ${policy.package.name}@${policy.package.version}`,
    `Target: ${policy.target.candidate} ${policy.target.target_triple} (${policy.target.status})`,
    'Scope: frozen four-instruction execution conformance only.',
    'This archive is preview evidence, not a production backend or Stable V1.0.',
    `Pending: ${policy.pending.map(({ id }) => id).join(', ')}`,
    '',
  ].join('\n')
}

function validExecution(value) {
  return plainObject(value)
    && exactShape(value, [
      'artifact_digest',
      'graph_revision',
      'invocations',
      'outcome',
    ])
    && DIGEST.test(value.artifact_digest)
    && DIGEST.test(value.graph_revision)
    && Array.isArray(value.invocations)
    && plainObject(value.outcome)
    && Number.isSafeInteger(value.outcome.code)
    && value.outcome.code >= 0
    && value.outcome.code <= 255
    && value.outcome.type === 'process.status'
}

function safeName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw codedError('portable-runtime-package-workload-id-invalid')
  }
  return value
}

function cString(value) {
  if (typeof value !== 'string') {
    throw codedError('portable-runtime-package-c-string-invalid')
  }
  return JSON.stringify(value)
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function digestValue(value) {
  return digestBytes(Buffer.from(canonicalJson(value), 'utf8'))
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function exactShape(value, fields) {
  return plainObject(value)
    && canonicalEqual(Object.keys(value).sort(), [...fields].sort())
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function codedError(code) {
  return Object.assign(new TypeError(code), { code })
}

function fail(code) {
  throw codedError(code)
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
