import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
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
import { isAbsolute, join } from 'node:path'

import {
  runTaskRuntimeLifecycleBenchmark,
} from './task-runtime-lifecycle.js'

export const NATIVE_RUNTIME_ABI_BUNDLE_SCHEMA =
  're.native-runtime-abi-bundle@0.1.0'
export const NATIVE_RUNTIME_ABI_REPORT_SCHEMA =
  're.native-runtime-abi-report@0.1.0'
export const NATIVE_RUNTIME_ABI_PROFILE =
  're.native-runtime-abi@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SCENARIO_KINDS = Object.freeze([
  'success-resource-close',
  'retry-transient-success',
  'permanent-error',
  'replay-existing-effect',
  'cancel-before-start',
  'parent-already-aborted',
  'timeout-late-effect',
  'parent-wins-timeout',
  'performer-host-fault',
  'stale-checkpoint',
  'resource-close-fault',
  'cleanup-first-fault',
  'listener-setup-fault',
  'timer-setup-fault',
])
const BUNDLE_FIELDS = [
  'bundle_digest',
  'corpus_digest',
  'package_digest',
  'profile',
  'reference_report_digest',
  'runtime',
  'schema',
  'target_triple',
  'workloads',
]
const BUNDLE_WORKLOAD_FIELDS = [
  'id',
  'request_digest',
  'scenario_kind',
  'source',
  'source_digest',
]
const REPORT_FIELDS = [
  'bundle_digest',
  'corpus_digest',
  'evidence_digest',
  'profile',
  'provenance',
  'reference_report_digest',
  'report_digest',
  'runtime',
  'schema',
  'stable_digest',
  'status',
  'target_triple',
  'workloads',
]
const REPORT_WORKLOAD_FIELDS = [
  'build',
  'executable_digest',
  'execution',
  'id',
  'request_digest',
  'run',
  'source_digest',
  'workload_digest',
]
const METRIC_FIELDS = ['samples_ns']
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

export function createNativeRuntimeAbiBundle({
  corpus,
  package_digest,
  reference,
  target_triple,
} = {}) {
  validateBundleInputs({ corpus, package_digest, reference, target_triple })
  const workloads = reference.workloads.map((workload, index) => {
    const scenario = corpus.scenarios[index]
    const source = nativeRuntimeAbiDriverCSource({
      scenario,
      workload,
    })
    return {
      id: scenario.id,
      request_digest: workload.request.request_digest,
      scenario_kind: scenario.kind,
      source,
      source_digest: digestBytes(Buffer.from(source, 'utf8')),
    }
  })
  const bundle = {
    corpus_digest: digestValue(corpus),
    package_digest,
    profile: NATIVE_RUNTIME_ABI_PROFILE,
    reference_report_digest: reference.report_digest,
    runtime: 'native-c11',
    schema: NATIVE_RUNTIME_ABI_BUNDLE_SCHEMA,
    target_triple,
    workloads,
  }
  bundle.bundle_digest = nativeRuntimeAbiBundleDigest(bundle)
  return bundle
}

export async function verifyNativeRuntimeAbiBundle(bundle, {
  corpus,
  package_digest,
  reference,
  target_triple,
} = {}) {
  try {
    validateBundleInputs({ corpus, package_digest, reference, target_triple })
    validateBundle(bundle)
    if (bundle.bundle_digest !== nativeRuntimeAbiBundleDigest(bundle)
      || bundle.corpus_digest !== digestValue(corpus)
      || bundle.package_digest !== package_digest
      || bundle.target_triple !== target_triple
      || bundle.reference_report_digest !== reference.report_digest) {
      fail('native-runtime-abi-bundle-authority-mismatch')
    }
    const fresh = await runTaskRuntimeLifecycleBenchmark(corpus)
    if (!fresh.ok || !canonicalEqual(fresh.value, reference)) {
      fail('native-runtime-abi-reference-authority-mismatch')
    }
    const expected = createNativeRuntimeAbiBundle({
      corpus,
      package_digest,
      reference: fresh.value,
      target_triple,
    })
    for (let index = 0; index < expected.workloads.length; index += 1) {
      if (!canonicalEqual(bundle.workloads[index], expected.workloads[index])) {
        fail('native-runtime-abi-source-authority-mismatch')
      }
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'native-runtime-abi-bundle-invalid')
  }
}

export async function runNativeRuntimeAbiConformance({
  compiler_path,
  corpus,
  package_digest,
  reference,
  samples = 2,
  target_triple,
} = {}) {
  let root = null
  try {
    validateBundleInputs({ corpus, package_digest, reference, target_triple })
    if (!isAbsolute(compiler_path)) fail('native-runtime-abi-compiler-path-invalid')
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > 8) {
      fail('native-runtime-abi-sample-count-invalid')
    }
    const compilerBytes = await readFile(compiler_path)
    const compilerMetadata = await stat(compiler_path)
    if (!compilerMetadata.isFile()) {
      fail('native-runtime-abi-compiler-invalid')
    }
    const compilerVersion = spawnSync(
      compiler_path,
      ['--version'],
      { encoding: 'utf8', shell: false },
    )
    if (compilerVersion.error || compilerVersion.status !== 0
      || compilerVersion.stdout.length === 0) {
      fail('native-runtime-abi-compiler-version-failed')
    }
    const bundle = createNativeRuntimeAbiBundle({
      corpus,
      package_digest,
      reference,
      target_triple,
    })
    const verifiedBundle = await verifyNativeRuntimeAbiBundle(bundle, {
      corpus,
      package_digest,
      reference,
      target_triple,
    })
    if (!verifiedBundle.ok) return verifiedBundle

    root = await mkdtemp(join(tmpdir(), 're-native-runtime-abi-'))
    const headerPath = join(root, 'native_runtime_abi.h')
    const corePath = join(root, 'native_runtime_abi.c')
    await writeFile(headerPath, nativeRuntimeAbiHeaderCSource(), 'utf8')
    await writeFile(corePath, nativeRuntimeAbiCoreCSource(), 'utf8')
    const workloads = []
    for (let index = 0; index < bundle.workloads.length; index += 1) {
      const bundleWorkload = bundle.workloads[index]
      const sourcePath = join(root, `${String(index).padStart(2, '0')}.c`)
      const executablePath = join(root, `${String(index).padStart(2, '0')}.bin`)
      await writeFile(sourcePath, bundleWorkload.source, 'utf8')
      const buildSamples = []
      let executableDigest = null
      for (let sample = 0; sample < samples; sample += 1) {
        const started = process.hrtime.bigint()
        const built = spawnSync(
          compiler_path,
          [
            '-O2',
            '-std=c11',
            '-target',
            target_triple,
            sourcePath,
            corePath,
            '-o',
            executablePath,
          ],
          { cwd: root, encoding: 'utf8', shell: false },
        )
        buildSamples.push(elapsed(started))
        if (built.error || built.status !== 0 || built.stderr !== '') {
          fail('native-runtime-abi-compile-failed', {
            stderr: built.stderr,
            stdout: built.stdout,
            workload: bundleWorkload.id,
          })
        }
        const currentDigest = digestBytes(await readFile(executablePath))
        if (executableDigest !== null && executableDigest !== currentDigest) {
          fail('native-runtime-abi-build-nondeterministic', {
            workload: bundleWorkload.id,
          })
        }
        executableDigest = currentDigest
      }

      const runSamples = []
      let stdout = null
      for (let sample = 0; sample < samples; sample += 1) {
        const started = process.hrtime.bigint()
        const executed = spawnSync(
          executablePath,
          [],
          { cwd: root, encoding: 'utf8', shell: false },
        )
        runSamples.push(elapsed(started))
        if (executed.error || executed.status !== 0 || executed.stderr !== '') {
          fail('native-runtime-abi-execution-failed', {
            signal: executed.signal,
            status: executed.status,
            stderr: executed.stderr,
            stdout: executed.stdout,
            workload: bundleWorkload.id,
          })
        }
        if (stdout !== null && stdout !== executed.stdout) {
          fail('native-runtime-abi-execution-nondeterministic', {
            workload: bundleWorkload.id,
          })
        }
        stdout = executed.stdout
      }

      let execution
      try {
        execution = JSON.parse(stdout)
      } catch (error) {
        fail('native-runtime-abi-output-invalid', {
          reason: error.message,
          stdout,
          workload: bundleWorkload.id,
        })
      }
      const authority = reference.workloads[index]
      if (execution.id !== authority.id
        || execution.request_digest !== authority.request.request_digest
        || !canonicalEqual(execution.result, authority.result)) {
        fail('native-runtime-abi-semantic-oracle-mismatch', {
          workload: bundleWorkload.id,
        })
      }
      const workload = {
        build: { samples_ns: buildSamples },
        executable_digest: executableDigest,
        execution,
        id: bundleWorkload.id,
        request_digest: bundleWorkload.request_digest,
        run: { samples_ns: runSamples },
        source_digest: bundleWorkload.source_digest,
      }
      workload.workload_digest = nativeRuntimeAbiWorkloadDigest(workload)
      workloads.push(workload)
    }

    const provenance = createProvenance({
      compiler_digest: digestBytes(compilerBytes),
      compiler_path,
      compiler_version_digest: digestBytes(
        Buffer.from(compilerVersion.stdout, 'utf8'),
      ),
      target_triple,
    })
    const report = {
      bundle_digest: bundle.bundle_digest,
      corpus_digest: bundle.corpus_digest,
      profile: NATIVE_RUNTIME_ABI_PROFILE,
      provenance,
      reference_report_digest: reference.report_digest,
      runtime: 'native-c11',
      schema: NATIVE_RUNTIME_ABI_REPORT_SCHEMA,
      status: 'measured',
      target_triple,
      workloads,
    }
    report.stable_digest = nativeRuntimeAbiStableDigest(report)
    report.evidence_digest = nativeRuntimeAbiEvidenceDigest(report)
    report.report_digest = nativeRuntimeAbiReportDigest(report)
    return { ok: true, value: report }
  } catch (error) {
    return rejected(error?.code ?? 'native-runtime-abi-runner-failed', error)
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function verifyNativeRuntimeAbiConformance(report, {
  compiler_path,
  corpus,
  package_digest,
  reference,
  target_triple,
} = {}) {
  try {
    validateBundleInputs({ corpus, package_digest, reference, target_triple })
    if (!isAbsolute(compiler_path)) {
      fail('native-runtime-abi-compiler-path-invalid')
    }
    validateReport(report)
    if (report.bundle_digest !== reportBundleDigest({
      corpus,
      package_digest,
      reference,
      target_triple,
    })
      || report.corpus_digest !== digestValue(corpus)
      || report.reference_report_digest !== reference.report_digest
      || report.target_triple !== target_triple
      || report.report_digest !== nativeRuntimeAbiReportDigest(report)) {
      fail('native-runtime-abi-report-authority-mismatch')
    }
    if (report.stable_digest !== nativeRuntimeAbiStableDigest(report)) {
      fail('native-runtime-abi-stable-digest-mismatch')
    }
    if (report.evidence_digest !== nativeRuntimeAbiEvidenceDigest(report)) {
      fail('native-runtime-abi-evidence-digest-mismatch')
    }
    const compilerIdentity = await validateCompiler(
      report.provenance,
      compiler_path,
    )
    const expectedProvenance = createProvenance({
      ...compilerIdentity,
      compiler_path,
      target_triple,
    })
    if (!canonicalEqual(report.provenance, expectedProvenance)) {
      fail('native-runtime-abi-provenance-authority-mismatch')
    }
    const fresh = await runTaskRuntimeLifecycleBenchmark(corpus)
    if (!fresh.ok || !canonicalEqual(fresh.value, reference)) {
      fail('native-runtime-abi-reference-authority-mismatch')
    }
    const bundle = createNativeRuntimeAbiBundle({
      corpus,
      package_digest,
      reference: fresh.value,
      target_triple,
    })
    for (let index = 0; index < report.workloads.length; index += 1) {
      const actual = report.workloads[index]
      const authority = fresh.value.workloads[index]
      const source = bundle.workloads[index]
      if (actual.id !== authority.id
        || actual.request_digest !== authority.request.request_digest
        || actual.source_digest !== source.source_digest
        || !canonicalEqual(actual.execution.result, authority.result)
        || actual.execution.id !== authority.id
        || actual.execution.request_digest !== authority.request.request_digest
        || actual.workload_digest !== nativeRuntimeAbiWorkloadDigest(actual)) {
        fail('native-runtime-abi-workload-authority-mismatch', {
          workload: actual.id,
        })
      }
    }
    const rerun = await runNativeRuntimeAbiConformance({
      compiler_path,
      corpus,
      package_digest,
      reference: fresh.value,
      samples: report.workloads[0].build.samples_ns.length,
      target_triple,
    })
    if (!rerun.ok) {
      fail(rerun.diagnostics[0].code)
    }
    for (let index = 0; index < report.workloads.length; index += 1) {
      if (report.workloads[index].executable_digest
        !== rerun.value.workloads[index].executable_digest) {
        fail('native-runtime-abi-executable-authority-mismatch', {
          workload: report.workloads[index].id,
        })
      }
    }
    if (report.stable_digest !== rerun.value.stable_digest) {
      fail('native-runtime-abi-stable-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'native-runtime-abi-report-invalid')
  }
}

export function nativeRuntimeAbiBundleDigest(bundle) {
  if (!plainObject(bundle)) throw new TypeError('invalid native ABI bundle')
  const { bundle_digest: ignored, ...content } = bundle
  return digestValue(content)
}

export function nativeRuntimeAbiWorkloadDigest(workload) {
  if (!plainObject(workload)) throw new TypeError('invalid native ABI workload')
  const {
    build: ignoredBuild,
    run: ignoredRun,
    workload_digest: ignored,
    ...content
  } = workload
  return digestValue(content)
}

export function nativeRuntimeAbiReportDigest(report) {
  if (!plainObject(report)) throw new TypeError('invalid native ABI report')
  const { report_digest: ignored, ...content } = report
  return digestValue(content)
}

export function nativeRuntimeAbiStableDigest(report) {
  if (!plainObject(report)) throw new TypeError('invalid native ABI report')
  const { stable_digest: ignored, evidence_digest: ignoredEvidence,
    report_digest: ignoredReport, ...content } = report
  return digestValue({
    ...content,
    workloads: content.workloads.map((workload) => {
      const { build: ignoredBuild, run: ignoredRun, ...stable } = workload
      return stable
    }),
  })
}

export function nativeRuntimeAbiEvidenceDigest(report) {
  if (!plainObject(report)) throw new TypeError('invalid native ABI report')
  const { evidence_digest: ignored, report_digest: ignoredReport, ...content } =
    report
  return digestValue(content)
}

export function nativeRuntimeAbiHeaderCSource() {
  return [
    '#ifndef REVIA_NATIVE_RUNTIME_ABI_H',
    '#define REVIA_NATIVE_RUNTIME_ABI_H',
    '',
    'typedef struct {',
    '  const char *cancel_reason_json;',
    '  const char *cleanup_events_json;',
    '  const char *effects_digest_json;',
    '  const char *error_json;',
    '  const char *output_digest_json;',
    '  const char *request_digest_json;',
    '  const char *result_digest_json;',
    '  const char *scenario_id_json;',
    '  const char *task_id_json;',
    '  const char *terminal_json;',
    '  const char *trace_digest_json;',
    '  const char *trace_json;',
    '  int attempts;',
    '  int effect_count;',
    '  int performer_calls;',
    '  int replayed;',
    '  int scenario_code;',
    '} revia_native_task_program;',
    '',
    'int revia_native_task_execute(const revia_native_task_program *program);',
    '',
    '#endif',
    '',
  ].join('\n')
}

export function nativeRuntimeAbiCoreCSource() {
  return [
    '#include "native_runtime_abi.h"',
    '',
    '#include <stdio.h>',
    '#include <string.h>',
    '',
    'static const char *TERMINALS[] = {',
    '  "succeeded", "succeeded", "failed", "succeeded",',
    '  "cancelled", "cancelled", "cancelled", "cancelled",',
    '  "rejected", "rejected", "rejected", "rejected",',
    '  "rejected", "rejected"',
    '};',
    '',
    'static int valid_program(const revia_native_task_program *program) {',
    '  if (program->scenario_code < 0 || program->scenario_code > 13) return 0;',
    '  if (strcmp(program->terminal_json, TERMINALS[program->scenario_code]) != 0) return 0;',
    '  if (program->attempts < 0 || program->effect_count < 0',
    '      || program->performer_calls < 0) return 0;',
    '  if (program->scenario_code == 1 && program->attempts != 3) return 0;',
    '  if (program->scenario_code == 3 && !program->replayed) return 0;',
    '  if ((program->scenario_code == 4 || program->scenario_code == 5)',
    '      && program->attempts != 0) return 0;',
    '  if (program->scenario_code == 6 || program->scenario_code == 7) {',
    '    if (program->attempts != 1 || program->performer_calls != 1) return 0;',
    '  }',
    '  return 1;',
    '}',
    '',
    'int revia_native_task_execute(const revia_native_task_program *program) {',
    '  if (program == NULL || !valid_program(program)) return 73;',
    '  printf("{\\"id\\":%s,\\"request_digest\\":%s,\\"result\\":{",',
    '    program->scenario_id_json, program->request_digest_json);',
    '  printf("\\"error\\":%s,\\"receipt\\":{\\"attempts\\":%d,\\"cancel_reason\\":%s,",',
    '    program->error_json, program->attempts, program->cancel_reason_json);',
    '  printf("\\"cleanup_events\\":%s,\\"effect_count\\":%d,\\"effects_digest\\":%s,",',
    '    program->cleanup_events_json, program->effect_count, program->effects_digest_json);',
    '  printf("\\"output_digest\\":%s,\\"performer_calls\\":%d,\\"replayed\\":%s,",',
    '    program->output_digest_json, program->performer_calls,',
    '    program->replayed ? "true" : "false");',
    '  printf("\\"schema\\":\\"re.task-runtime-lifecycle-receipt@0.1.0\\",\\"task_id\\":%s,\\"trace\\":%s},",',
    '    program->task_id_json, program->trace_json);',
    '  printf("\\"request_digest\\":%s,\\"schema\\":\\"re.task-runtime-lifecycle-result@0.1.0\\",\\"terminal\\":\\"%s\\",",',
    '    program->request_digest_json, program->terminal_json);',
    '  printf("\\"trace_digest\\":%s,\\"result_digest\\":%s}}\\n",',
    '    program->trace_digest_json, program->result_digest_json);',
    '  return 0;',
    '}',
    '',
  ].join('\n')
}

export function nativeRuntimeAbiDriverCSource({ scenario, workload } = {}) {
  if (!plainObject(scenario) || !plainObject(workload)
    || typeof scenario.id !== 'string'
    || !SCENARIO_KINDS.includes(scenario.kind)
    || workload.id !== scenario.id
    || !plainObject(workload.request)
    || !plainObject(workload.result)) {
    fail('native-runtime-abi-driver-input-invalid')
  }
  const result = workload.result
  const receipt = result.receipt
  const scenarioCode = SCENARIO_KINDS.indexOf(scenario.kind)
  const values = [
    ['cancel_reason_json', canonicalJson(receipt.cancel_reason)],
    ['cleanup_events_json', canonicalJson(receipt.cleanup_events)],
    ['effects_digest_json', JSON.stringify(receipt.effects_digest)],
    ['error_json', canonicalJson(result.error)],
    ['output_digest_json', canonicalJson(receipt.output_digest)],
    ['request_digest_json', JSON.stringify(workload.request.request_digest)],
    ['result_digest_json', JSON.stringify(result.result_digest)],
    ['scenario_id_json', JSON.stringify(scenario.id)],
    ['task_id_json', JSON.stringify(receipt.task_id)],
    ['terminal_json', result.terminal],
    ['trace_digest_json', JSON.stringify(result.trace_digest)],
    ['trace_json', canonicalJson(receipt.trace)],
    ['attempts', receipt.attempts],
    ['effect_count', receipt.effect_count],
    ['performer_calls', receipt.performer_calls],
    ['replayed', receipt.replayed ? 1 : 0],
    ['scenario_code', scenarioCode],
  ]
  return [
    '#include "native_runtime_abi.h"',
    '',
    'int main(void) {',
    '  static const revia_native_task_program program = {',
    ...values.map(([field, value]) => (
      `    .${field} = ${typeof value === 'number' ? value : cString(value)},`
    )),
    '  };',
    '  return revia_native_task_execute(&program);',
    '}',
    '',
  ].join('\n')
}

function reportBundleDigest({ corpus, package_digest, reference, target_triple }) {
  return createNativeRuntimeAbiBundle({
    corpus,
    package_digest,
    reference,
    target_triple,
  }).bundle_digest
}

function validateBundleInputs({
  corpus,
  package_digest,
  reference,
  target_triple,
}) {
  if (!plainObject(corpus)
    || corpus.schema !== 're.task-runtime-lifecycle-corpus@0.1.0'
    || !Array.isArray(corpus.scenarios)
    || corpus.scenarios.length !== SCENARIO_KINDS.length
    || !DIGEST.test(package_digest)
    || !plainObject(reference)
    || reference.schema !== 're.task-runtime-lifecycle-report@0.1.0'
    || !DIGEST.test(reference.report_digest)
    || typeof target_triple !== 'string'
    || target_triple.length === 0) {
    fail('native-runtime-abi-input-invalid')
  }
  for (let index = 0; index < SCENARIO_KINDS.length; index += 1) {
    const scenario = corpus.scenarios[index]
    if (!plainObject(scenario)
      || scenario.kind !== SCENARIO_KINDS[index]
      || typeof scenario.id !== 'string') {
      fail('native-runtime-abi-scenario-authority-invalid')
    }
  }
}

function validateBundle(bundle) {
  if (!plainObject(bundle)
    || !exactShape(bundle, BUNDLE_FIELDS)
    || bundle.schema !== NATIVE_RUNTIME_ABI_BUNDLE_SCHEMA
    || bundle.profile !== NATIVE_RUNTIME_ABI_PROFILE
    || bundle.runtime !== 'native-c11'
    || !DIGEST.test(bundle.bundle_digest)
    || !DIGEST.test(bundle.corpus_digest)
    || !DIGEST.test(bundle.package_digest)
    || !DIGEST.test(bundle.reference_report_digest)
    || !Array.isArray(bundle.workloads)
    || bundle.workloads.length !== SCENARIO_KINDS.length
    || !bundle.workloads.every((workload) => (
      plainObject(workload)
      && exactShape(workload, BUNDLE_WORKLOAD_FIELDS)
      && typeof workload.id === 'string'
      && typeof workload.request_digest === 'string'
      && SCENARIO_KINDS.includes(workload.scenario_kind)
      && typeof workload.source === 'string'
      && DIGEST.test(workload.source_digest)
    ))) {
    fail('native-runtime-abi-bundle-invalid')
  }
}

function validateReport(report) {
  if (!plainObject(report)
    || !exactShape(report, REPORT_FIELDS)
    || report.schema !== NATIVE_RUNTIME_ABI_REPORT_SCHEMA
    || report.profile !== NATIVE_RUNTIME_ABI_PROFILE
    || report.runtime !== 'native-c11'
    || report.status !== 'measured'
    || !DIGEST.test(report.bundle_digest)
    || !DIGEST.test(report.corpus_digest)
    || !DIGEST.test(report.reference_report_digest)
    || !DIGEST.test(report.stable_digest)
    || !DIGEST.test(report.evidence_digest)
    || !DIGEST.test(report.report_digest)
    || !Array.isArray(report.workloads)
    || report.workloads.length !== SCENARIO_KINDS.length) {
    fail('native-runtime-abi-report-invalid')
  }
  validateProvenance(report.provenance)
  for (const workload of report.workloads) {
    if (!plainObject(workload)
      || !exactShape(workload, REPORT_WORKLOAD_FIELDS)
      || typeof workload.id !== 'string'
      || !DIGEST.test(workload.executable_digest)
      || !plainObject(workload.execution)
      || !DIGEST.test(workload.request_digest)
      || !DIGEST.test(workload.source_digest)
      || !DIGEST.test(workload.workload_digest)
      || !plainObject(workload.execution)
      || !exactShape(workload.execution, ['id', 'request_digest', 'result'])) {
      fail('native-runtime-abi-workload-invalid')
    }
    validateMetric(workload.build)
    validateMetric(workload.run)
    if (workload.build.samples_ns.length !== workload.run.samples_ns.length) {
      fail('native-runtime-abi-metric-invalid')
    }
  }
  const sampleCount = report.workloads[0].build.samples_ns.length
  if (!report.workloads.every(({ build, run }) => (
    build.samples_ns.length === sampleCount
    && run.samples_ns.length === sampleCount
  ))) {
    fail('native-runtime-abi-metric-invalid')
  }
}

function validateProvenance(value) {
  if (!plainObject(value)
    || !exactShape(value, PROVENANCE_FIELDS)
    || !DIGEST.test(value.compiler_digest)
    || !isAbsolute(value.compiler_path)
    || !DIGEST.test(value.compiler_version_digest)
    || !DIGEST.test(value.host_identity_digest)
    || typeof value.environment_id !== 'string'
    || typeof value.runner_id !== 'string'
    || value.measurement_source !== 'runner'
    || value.synthetic !== false
    || typeof value.operating_system !== 'string'
    || typeof value.architecture !== 'string'
    || typeof value.target_triple !== 'string') {
    fail('native-runtime-abi-provenance-invalid')
  }
}

async function validateCompiler(provenance, compilerPath) {
  if (provenance.compiler_path !== compilerPath) {
    fail('native-runtime-abi-compiler-path-mismatch')
  }
  const bytes = await readFile(compilerPath)
  const version = spawnSync(
    compilerPath,
    ['--version'],
    { encoding: 'utf8', shell: false },
  )
  if (version.error
    || version.status !== 0
    || digestBytes(bytes) !== provenance.compiler_digest
    || digestBytes(Buffer.from(version.stdout, 'utf8'))
      !== provenance.compiler_version_digest) {
    fail('native-runtime-abi-compiler-identity-mismatch')
  }
  return {
    compiler_digest: provenance.compiler_digest,
    compiler_version_digest: provenance.compiler_version_digest,
  }
}

function validateMetric(value) {
  if (!plainObject(value)
    || !exactShape(value, METRIC_FIELDS)
    || !Array.isArray(value.samples_ns)
    || value.samples_ns.length < 1
    || value.samples_ns.length > 8
    || !value.samples_ns.every((sample) => (
      Number.isSafeInteger(sample) && sample > 0
    ))) {
    fail('native-runtime-abi-metric-invalid')
  }
}

function createProvenance({
  compiler_digest,
  compiler_path,
  compiler_version_digest,
  target_triple,
}) {
  const operating_system = platform()
  const architecture = arch()
  return {
    architecture,
    compiler_digest,
    compiler_path,
    compiler_version_digest,
    environment_id: `${operating_system}-${architecture}-native-runtime-abi`,
    host_identity_digest: digestValue({
      architecture,
      compiler_digest,
      operating_system,
      release: release(),
      target_triple,
    }),
    measurement_source: 'runner',
    operating_system,
    runner_id: NATIVE_RUNTIME_ABI_PROFILE,
    synthetic: false,
    target_triple,
  }
}

function elapsed(started) {
  const value = Number(process.hrtime.bigint() - started)
  return Number.isSafeInteger(value) && value > 0 ? value : 1
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

function cString(value) {
  return JSON.stringify(String(value))
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

function rejected(code, detail = {}) {
  return { diagnostics: [{ code, ...detail }], ok: false }
}

function fail(code, detail = {}) {
  const error = new Error(code)
  error.code = code
  Object.assign(error, detail)
  throw error
}
