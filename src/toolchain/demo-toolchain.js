import { createHash } from 'node:crypto'

import { demoSchemaDefinitions } from '../host/demo-schema.js'
import { runProgram } from '../host/demo-runner.js'
import { SchemaRegistry } from '../host/schema-registry.js'
import { serializeCanonicalGraph } from './canonical.js'
import { checkProgram } from './checker.js'
import { commit, createGraph } from './creation-transaction.js'
import { evaluateProgram } from './evaluator.js'
import { EXECUTABLE_GRAMMAR_PROFILE } from './executable-grammar-profile.js'
import { parseExecutableSource } from './executable-source.js'
import {
  COMPACT_IDENTITY_ALLOCATOR,
  deterministicUidFactory,
} from './graph-identity.js'
import { moduleInterfaceDigest } from './module-contract.js'
import { applyStructuredPatch, graphRevision } from './structured-patch.js'
import { translateCheckedGraph } from './translation-artifact.js'
import {
  buildProjectReviewIndex,
  buildReviewManifest,
  expandProjectReviewFact,
} from './review-manifest.js'

const loadedRegistry = SchemaRegistry.load(demoSchemaDefinitions())
if (!loadedRegistry.ok) {
  throw new Error('Built-in Demo schema registry is invalid')
}

const PREVIEW_RUNTIME_KIND = 'self-contained-node-demo-runtime'
const PREVIEW_TARGET_PROFILE = 'node-demo-self-contained-preview@0.1.0'
const PREVIEW_TOOLCHAIN_IMPLEMENTATION = 'node-demo-preview'

const PROFILE_CANDIDATES = Object.freeze([
  Object.freeze({
    artifact_kind: 'native-aot',
    id: 'aot-llvm',
    role: 'production-candidate',
  }),
  Object.freeze({
    artifact_kind: 'native-aot',
    id: 'cranelift',
    role: 'production-candidate',
  }),
  Object.freeze({
    artifact_kind: 'native-aot',
    id: 'go-lowering',
    role: 'production-candidate',
  }),
  Object.freeze({
    artifact_kind: 'managed-bytecode',
    id: 'jvm-bytecode',
    role: 'production-candidate',
  }),
  Object.freeze({
    artifact_kind: 'host-script',
    id: 'node-reference',
    role: 'semantic-reference',
  }),
])

const PROFILE_WORKLOADS = Object.freeze([
  Object.freeze({
    id: 'cpu-pure-graph',
    required_axes: Object.freeze([
      'throughput_ops_sec',
      'p99_ms',
      'allocation_bytes',
      'peak_rss_bytes',
    ]),
  }),
  Object.freeze({
    id: 'json-http',
    required_axes: Object.freeze([
      'throughput_ops_sec',
      'p50_ms',
      'p95_ms',
      'p99_ms',
      'peak_rss_bytes',
      'local_adapter_overhead_ns',
    ]),
  }),
  Object.freeze({
    id: 'db-transaction',
    required_axes: Object.freeze([
      'throughput_ops_sec',
      'p50_ms',
      'p95_ms',
      'p99_ms',
      'foreign_adapter_overhead_ns',
    ]),
  }),
  Object.freeze({
    id: 'task-10k',
    required_axes: Object.freeze([
      'throughput_ops_sec',
      'p99_ms',
      'cancel_latency_p99_ms',
      'allocation_bytes',
      'peak_rss_bytes',
    ]),
  }),
  Object.freeze({
    id: 'task-100k',
    required_axes: Object.freeze([
      'throughput_ops_sec',
      'p99_ms',
      'cancel_latency_p99_ms',
      'allocation_bytes',
      'peak_rss_bytes',
      'gc_pause_p99_ms',
    ]),
  }),
  Object.freeze({
    id: 'module-50-clean-incremental',
    required_axes: Object.freeze([
      'clean_build_ms',
      'incremental_build_ms',
      'artifact_bytes',
    ]),
  }),
  Object.freeze({
    id: 'module-500-clean-incremental',
    required_axes: Object.freeze([
      'clean_build_ms',
      'incremental_build_ms',
      'artifact_bytes',
      'peak_rss_bytes',
    ]),
  }),
  Object.freeze({
    id: 'module-5000-clean-incremental',
    required_axes: Object.freeze([
      'clean_build_ms',
      'incremental_build_ms',
      'artifact_bytes',
      'peak_rss_bytes',
    ]),
  }),
])

export function checkSource(source, { file = '<input>', uidFactory } = {}) {
  const parsed = parseExecutableSource(source, { file })
  if (!parsed.ok) return parsed
  return checkParsedGraph(parsed.value, file, { uidFactory })
}

export function runSource(
  source,
  { argv = [], file = '<input>', fileSandboxRoot, host = {} } = {},
) {
  const checked = checkSource(source, { file })
  const stdout = []
  return runProgram({
    check: () => checked,
    execute: () =>
      evaluateProgram(checked.program, {
        argv,
        fileSandboxRoot,
        host,
        stdout,
      }),
    readProgramStdout: () => stdout.join(''),
  })
}

export function patchSource(source, patch, { file = '<input>' } = {}) {
  const parsed = parseExecutableSource(source, { file })
  if (!parsed.ok) return parsed
  if (parsed.form !== 'canonical') {
    return {
      diagnostics: [{ code: 'patch-requires-canonical-input' }],
      ok: false,
    }
  }
  const checked = checkParsedGraph(parsed.value, file)
  if (!checked.ok) return checked
  return applyStructuredPatch(checked.program, patch, {
    check: (graph) =>
      checkProgram(graph, { file, registry: loadedRegistry.value }),
  })
}

function checkParsedGraph(graph, file, { uidFactory } = {}) {
  return commit(
    createGraph(graph, {
      check: (candidate) =>
        checkProgram(candidate, { file, registry: loadedRegistry.value }),
      ...(uidFactory === undefined ? {} : { uidFactory }),
    }),
  )
}

export function reviewSource(
  source,
  { file = '<input>', moduleInterfaceDigest } = {},
) {
  const checked = checkSource(source, { file })
  if (!checked.ok) return checked
  return {
    ok: true,
    value: buildReviewManifest(checked.program, { moduleInterfaceDigest }),
  }
}

export function auditSource(source, { file = '<input>' } = {}) {
  const checked = checkSource(source, { file })
  if (!checked.ok) return checked
  return {
    ok: true,
    value: buildAuditProjection(checked.program),
  }
}

const VIEW_LOCALES = new Set(['zh-CN', 'en-US'])

export function viewSource(
  source,
  { file = '<input>', format = 'text', locale = 'zh-CN' } = {},
) {
  if (!VIEW_LOCALES.has(locale)) {
    return { diagnostics: [{ code: 'unsupported-view-locale', locale }], ok: false }
  }
  const checked = checkSource(source, { file })
  if (!checked.ok) return checked
  const audit = buildAuditProjection(checked.program)
  const semanticView = { ...buildSemanticView(checked.program, audit), locale }
  if (format === 'html') {
    return {
      ok: true,
      value: {
        html: renderHtmlView(semanticView),
        semanticView,
      },
    }
  }
  if (format === 'svg') {
    return {
      ok: true,
      value: {
        semanticView,
        svg: renderSvgView(semanticView),
      },
    }
  }
  return {
    ok: true,
    value: {
      semanticView,
      text: renderTextView(semanticView),
    },
  }
}

export function reviewIndexSource(
  source,
  { changedSince = null, cursor = null, file = '<input>', limit = 50 } = {},
) {
  const checked = checkSource(source, { file })
  if (!checked.ok) return checked
  const manifest = buildReviewManifest(checked.program, {
    moduleInterfaceDigest: previewModuleInterfaceDigest(checked.program),
  })
  return buildProjectReviewIndex(manifest, { changedSince, cursor, limit })
}

export function reviewFactSource(
  source,
  { factId, indexRevision, file = '<input>' } = {},
) {
  const checked = checkSource(source, { file })
  if (!checked.ok) return checked
  const manifest = buildReviewManifest(checked.program, {
    moduleInterfaceDigest: previewModuleInterfaceDigest(checked.program),
  })
  return expandProjectReviewFact(manifest, { factId, indexRevision })
}

export function profileSource(source, { file = '<input>' } = {}) {
  const checked = checkSource(source, {
    file,
    uidFactory: deterministicUidFactory(),
  })
  if (!checked.ok) return checked
  const benchmarkProfile = {
    candidates: PROFILE_CANDIDATES.map((candidate) => ({ ...candidate })),
    schema: 're.benchmark-profile@0.1.0',
    workloads: PROFILE_WORKLOADS.map(({ id, required_axes }) => ({
      id,
      required_axes: [...required_axes],
    })),
  }
  return {
    ok: true,
    value: {
      benchmark_profile_digest: canonicalSha256(benchmarkProfile),
      candidates: benchmarkProfile.candidates,
      graph_revision: graphRevision(checked.program),
      measurement_status: 'not-run',
      module_interface_digest: previewModuleInterfaceDigest(checked.program),
      runtime: {
        kind: PREVIEW_RUNTIME_KIND,
      },
      schema: 're.profile-descriptor@0.1.0',
      target_profile: PREVIEW_TARGET_PROFILE,
      workloads: benchmarkProfile.workloads,
    },
  }
}

export function translateSource(source, { file = '<input>' } = {}) {
  const checked = checkSource(source, {
    file,
    uidFactory: deterministicUidFactory(),
  })
  if (!checked.ok) return checked
  return translateCheckedGraph(checked.program)
}

export function buildSource(
  source,
  { file = '<input>', sourceBytes = Buffer.from(source, 'utf8') } = {},
) {
  const checked = checkSource(source, { file })
  if (!checked.ok) return checked
  const canonical = serializeCanonicalGraph(checked.program)
  const audit = buildAuditProjection(checked.program)
  const moduleDigest = previewModuleInterfaceDigest(checked.program)
  const reviewManifest = buildReviewManifest(checked.program, {
    moduleInterfaceDigest: moduleDigest,
  })
  const reviewIndex = buildProjectReviewIndex(reviewManifest, { limit: 50 }).value
  const semanticView = buildSemanticView(checked.program, audit)
  const semanticViewContent = canonicalJson(semanticView)
  const reviewIndexContent = canonicalJson(reviewIndex)
  const sourceDigest = sha256Hex(sourceBytes)
  const buildKey = previewBuildKey(checked.program, {
    moduleInterfaceDigest: moduleDigest,
    sourceDigest,
  })
  const semanticViewDigest = sha256Hex(Buffer.from(semanticViewContent, 'utf8'))
  const releaseLock = buildReleaseLock(checked.program, {
    buildKey,
    moduleInterfaceDigest: moduleDigest,
    reviewIndexRevision: reviewIndex.index_revision,
    semanticViewDigest,
    sourceDigest,
  })
  const releaseLockContent = canonicalJson(releaseLock)
  const manifest = buildArtifactManifest(checked.program, {
    buildKey,
    moduleInterfaceDigest: moduleDigest,
    releaseLockDigest: sha256Hex(Buffer.from(releaseLockContent, 'utf8')),
    reviewIndexRevision: reviewIndex.index_revision,
    semanticViewDigest,
    sourceDigest,
  })
  const files = [
    {
      content: canonical,
      executable: false,
      path: 'program.re',
    },
    {
      content: releaseLockContent,
      executable: false,
      path: 'release-lock.json',
    },
    {
      content: buildRunStub(checked.program, { buildKey }),
      executable: true,
      path: 'run.mjs',
    },
    {
      content: reviewIndexContent,
      executable: false,
      path: 'review-index.json',
    },
    {
      content: semanticViewContent,
      executable: false,
      path: 'semantic-view.json',
    },
  ]
  const fileMetadata = files.map((artifactFile) => ({
    bytes: Buffer.byteLength(artifactFile.content, 'utf8'),
    executable: artifactFile.executable,
    path: artifactFile.path,
    sha256: sha256Hex(Buffer.from(artifactFile.content, 'utf8')),
  }))
  const manifestContent = canonicalJson({
    ...manifest,
    files: fileMetadata,
  })
  const manifestMetadata = {
    bytes: Buffer.byteLength(manifestContent, 'utf8'),
    executable: false,
    path: 'manifest.json',
    sha256: sha256Hex(Buffer.from(manifestContent, 'utf8')),
  }
  const checksumsContent = renderChecksums([
    ...fileMetadata,
    manifestMetadata,
  ])
  return {
    ok: true,
    value: {
      files: [
        ...files,
        {
          content: manifestContent,
          executable: false,
          path: 'manifest.json',
        },
        {
          content: checksumsContent,
          executable: false,
          path: 'checksums.sha256',
        },
      ],
      manifest: {
        ...manifest,
        files: fileMetadata,
        checksums_sha256: sha256Hex(Buffer.from(checksumsContent, 'utf8')),
        manifest_sha256: manifestMetadata.sha256,
      },
    },
  }
}

function previewModuleInterfaceDigest(program) {
  return moduleInterfaceDigest({
    dependencies: [],
    exports: [],
    module: program.unit.replace(/^@/, ''),
    schema: 're.module-interface@0.1.0',
  })
}

function buildAuditProjection(program) {
  const main = program.functions.find((candidate) => candidate.name === '@main')
  const literalsByUid = new Map(
    (main?.literals ?? []).map((literal) => [literal.uid, literal]),
  )
  const statements = new Map(
    (main?.statements ?? []).map((statement) => [statement.uid, statement]),
  )
  const capabilities = program.capabilities.map((capability) => ({
    binding_kind: bindingKind(capability.reference),
    instance: capability.instance,
    reference: capability.reference,
  }))
  const resultConsumers = new Map()
  for (const statement of main?.statements ?? []) {
    if (statement.kind !== 'return') continue
    const producer = statement.value.input.producer
    const consumers = resultConsumers.get(producer) ?? []
    consumers.push(statement.uid)
    resultConsumers.set(producer, consumers)
  }
  const effects = (main?.statements ?? [])
    .filter((statement) => statement.kind === 'let')
    .map((statement) => {
      const call = statement.value
      const member = schemaMember(call.target.schemaReference, call.target.member)
      return {
        access: member.access,
        capability_instance: call.target.instance,
        member: call.target.member,
        node_uid: call.uid,
        result_consumers: resultConsumers.get(statement.uid) ?? [],
        returns: member.returns,
      }
    })
  const statusCodes = []
  const errorPaths = []
  for (const statement of main?.statements ?? []) {
    if (statement.kind !== 'return') continue
    const producer = statements.get(statement.value.input.producer)
    const errorType = producer?.value?.returnType === undefined
      ? null
      : resultErrorType(producer.value.returnType)
    for (const branch of statement.value.branches) {
      const code = processExitCode(branch.value, literalsByUid)
      if (code !== null) statusCodes.push(code)
      if (branch.variant === 'err' && errorType !== null) {
        errorPaths.push({
          consumer_uid: statement.uid,
          error_type: errorType,
          producer_uid: producer.value.uid,
          status_codes: code === null ? [] : [code],
        })
      }
    }
  }
  return {
    capabilities,
    effects,
    errorPaths,
    statusCodes,
  }
}

function buildArtifactManifest(
  program,
  {
    buildKey,
    moduleInterfaceDigest,
    releaseLockDigest,
    reviewIndexRevision,
    semanticViewDigest,
    sourceDigest,
  },
) {
  const audit = buildAuditProjection(program)
  return {
    build_key: buildKey,
    graph_revision: graphRevision(program),
    identity_allocator: COMPACT_IDENTITY_ALLOCATOR,
    module_interface_digest: moduleInterfaceDigest,
    preview_release: {
      checksums: 'checksums.sha256',
      release_lock: {
        path: 'release-lock.json',
        schema: 're.release-lock@0.1.0',
        sha256: releaseLockDigest,
      },
      review_index: {
        path: 'review-index.json',
        revision: reviewIndexRevision,
        schema: 're.project-review-index@0.1.0',
      },
      semantic_view: {
        path: 'semantic-view.json',
        schema: 're.semantic-view-ir@0.1.0',
        sha256: semanticViewDigest,
      },
    },
    required_capabilities: audit.capabilities
      .map((capability) => ({
        binding_kind: capability.binding_kind,
        instance: capability.instance,
        reference: capability.reference,
      }))
      .sort((left, right) => compareUtf8(left.instance, right.instance)),
    runtime: {
      entrypoint: 'run.mjs',
      kind: PREVIEW_RUNTIME_KIND,
    },
    schema: 're.build-artifact@0.1.0',
    source_sha256: sourceDigest,
    target_profile: PREVIEW_TARGET_PROFILE,
    unit: program.unit,
  }
}

function buildReleaseLock(
  program,
  { buildKey, moduleInterfaceDigest, reviewIndexRevision, semanticViewDigest, sourceDigest },
) {
  return {
    artifact: {
      files: [
        'program.re',
        'release-lock.json',
        'review-index.json',
        'run.mjs',
        'semantic-view.json',
      ],
      kind: 'preview-self-contained-artifact',
      runtime_entrypoint: 'run.mjs',
    },
    build_key: buildKey,
    canonical: {
      graph_revision: graphRevision(program),
      source_sha256: sourceDigest,
    },
    identity_allocator: COMPACT_IDENTITY_ALLOCATOR,
    language: {
      canonical_schema: EXECUTABLE_GRAMMAR_PROFILE.canonical_schema,
      grammar: EXECUTABLE_GRAMMAR_PROFILE.descriptor,
      grammar_profile: EXECUTABLE_GRAMMAR_PROFILE.schema,
      name: 'RE',
    },
    module_interface_digest: moduleInterfaceDigest,
    output_protocols: {
      build_result: 're.build-result@0.1.0',
      check_result: 're.check-result@0.1.0',
      project_review_index: {
        revision: reviewIndexRevision,
        schema: 're.project-review-index@0.1.0',
      },
      semantic_view: {
        schema: 're.semantic-view-ir@0.1.0',
        sha256: semanticViewDigest,
      },
    },
    runtime: {
      kind: PREVIEW_RUNTIME_KIND,
      target_profile: PREVIEW_TARGET_PROFILE,
    },
    schema: 're.release-lock@0.1.0',
    toolchain: {
      commands: [
        'check',
        'run',
        'manifest',
        'patch',
        'audit',
        'view',
        'build',
        'profile',
        'review-index',
        'translate',
      ],
      implementation: PREVIEW_TOOLCHAIN_IMPLEMENTATION,
    },
    unit: program.unit,
  }
}

function previewBuildKey(program, { moduleInterfaceDigest, sourceDigest }) {
  return canonicalSha256({
    grammar_profile: EXECUTABLE_GRAMMAR_PROFILE.schema,
    graph_revision: graphRevision(program),
    identity_allocator: COMPACT_IDENTITY_ALLOCATOR,
    module_interface_digest: moduleInterfaceDigest,
    runtime_kind: PREVIEW_RUNTIME_KIND,
    schema: 're.preview-build-key@0.1.0',
    source_sha256: sourceDigest,
    target_profile: PREVIEW_TARGET_PROFILE,
    toolchain_implementation: PREVIEW_TOOLCHAIN_IMPLEMENTATION,
  })
}

function renderChecksums(files) {
  return files
    .map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((left, right) => compareUtf8(left.path, right.path))
    .map(({ path, sha256 }) => `${sha256}  ${path}\n`)
    .join('')
}

function buildRunStub(program, { buildKey }) {
  const programJson = canonicalJson(stripLocations(program))
  const expectedReleaseLockJson = canonicalJson({
    build_key: buildKey,
    graph_revision: graphRevision(program),
    identity_allocator: COMPACT_IDENTITY_ALLOCATOR,
    runtime_kind: PREVIEW_RUNTIME_KIND,
    schema: 're.release-lock@0.1.0',
    target_profile: PREVIEW_TARGET_PROFILE,
  })
  return `#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const program = ${programJson}
const expectedReleaseLock = ${expectedReleaseLockJson}
const expectedArtifactPaths = [
  'manifest.json',
  'program.re',
  'release-lock.json',
  'review-index.json',
  'run.mjs',
  'semantic-view.json',
]

try {
  verifyArtifactChecksums()
  verifyArtifactManifest()
  verifyReleaseLock()
  const status = evaluate(program)
  process.exitCode = status.code
} catch (error) {
  process.stderr.write(\`re artifact runtime error: \${error.message}\\n\`)
  process.exitCode = 70
}

function verifyArtifactChecksums() {
  let content
  try {
    content = readFileSync(resolve(here, 'checksums.sha256'), 'utf8')
  } catch {
    throw new Error('artifact checksum file unreadable')
  }
  if (!content.endsWith('\\n')) {
    throw new Error('artifact checksum file malformed')
  }

  const entries = new Map()
  for (const line of content.slice(0, -1).split('\\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line)
    if (match === null) {
      throw new Error('artifact checksum file malformed')
    }
    const [, digest, path] = match
    if (!expectedArtifactPaths.includes(path)) {
      throw new Error(\`artifact checksum unknown entry: \${path}\`)
    }
    if (entries.has(path)) {
      throw new Error(\`artifact checksum duplicate entry: \${path}\`)
    }
    entries.set(path, digest)
  }

  for (const path of expectedArtifactPaths) {
    if (!entries.has(path)) {
      throw new Error(\`artifact checksum missing entry: \${path}\`)
    }
    let bytes
    try {
      bytes = readFileSync(resolve(here, path))
    } catch {
      throw new Error(\`artifact file unreadable: \${path}\`)
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== entries.get(path)) {
      throw new Error(\`artifact checksum mismatch: \${path}\`)
    }
  }
}

function verifyArtifactManifest() {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(resolve(here, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error('artifact manifest invalid JSON')
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('artifact manifest schema mismatch')
  }
  if (manifest.schema !== 're.build-artifact@0.1.0') {
    throw new Error('artifact manifest schema mismatch')
  }
  if (manifest.build_key !== expectedReleaseLock.build_key) {
    throw new Error('artifact manifest build key mismatch')
  }
  if (
    manifest.identity_allocator?.algorithm !== expectedReleaseLock.identity_allocator.algorithm
    || manifest.identity_allocator?.schema !== expectedReleaseLock.identity_allocator.schema
  ) {
    throw new Error('artifact manifest identity allocator mismatch')
  }
  const releaseLock = manifest.preview_release?.release_lock
  if (
    releaseLock?.path !== 'release-lock.json'
    || releaseLock?.schema !== expectedReleaseLock.schema
  ) {
    throw new Error('artifact manifest release lock identity mismatch')
  }
  let releaseLockBytes
  try {
    releaseLockBytes = readFileSync(resolve(here, 'release-lock.json'))
  } catch {
    throw new Error('artifact file unreadable: release-lock.json')
  }
  const actualDigest = createHash('sha256').update(releaseLockBytes).digest('hex')
  if (releaseLock.sha256 !== actualDigest) {
    throw new Error('artifact manifest release lock digest mismatch')
  }
}

function verifyReleaseLock() {
  let content
  try {
    content = readFileSync(resolve(here, 'release-lock.json'), 'utf8')
  } catch {
    throw new Error('release lock unreadable')
  }

  let lock
  try {
    lock = JSON.parse(content)
  } catch {
    throw new Error('release lock invalid JSON')
  }
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
    throw new Error('release lock schema mismatch')
  }
  if (lock.schema !== expectedReleaseLock.schema) {
    throw new Error('release lock schema mismatch')
  }
  if (lock.build_key !== expectedReleaseLock.build_key) {
    throw new Error('release lock build key mismatch')
  }
  if (lock.canonical?.graph_revision !== expectedReleaseLock.graph_revision) {
    throw new Error('release lock graph revision mismatch')
  }
  if (
    lock.identity_allocator?.algorithm !== expectedReleaseLock.identity_allocator.algorithm
    || lock.identity_allocator?.schema !== expectedReleaseLock.identity_allocator.schema
  ) {
    throw new Error('release lock identity allocator mismatch')
  }
  if (lock.runtime?.kind !== expectedReleaseLock.runtime_kind) {
    throw new Error('release lock runtime kind mismatch')
  }
  if (lock.runtime?.target_profile !== expectedReleaseLock.target_profile) {
    throw new Error('release lock target profile mismatch')
  }
}

function evaluate(program) {
  const main = program.functions.find((candidate) => candidate.name === '@main')
  const statements = new Map(main.statements.map((statement) => [statement.uid, statement]))
  const literals = new Map((main.literals ?? []).map((literal) => [literal.uid, literal]))
  const returned = main.statements.find((statement) => statement.kind === 'return')
  const values = new Map()

  const evaluateStatement = (statement) => {
    if (values.has(statement.uid)) return values.get(statement.uid)
    const value = statement.kind === 'let'
      ? evaluateCall(statement.value, literals)
      : evaluateMatch(statement.value, statements, literals, evaluateStatement)
    values.set(statement.uid, value)
    return value
  }

  const status = evaluateStatement(returned)
  if (status.type !== 'process.status') {
    throw new Error('program did not return process.status')
  }
  return status
}

function evaluateMatch(match, statements, literals, evaluateStatement) {
  const producer = statements.get(match.input.producer)
  const outcome = evaluateStatement(producer)
  const branch = match.branches.find((candidate) => candidate.variant === outcome.value.kind)
  if (branch === undefined) {
    throw new Error(\`missing result branch: \${outcome.value.kind}\`)
  }
  return evaluateCall(branch.value, literals)
}

function evaluateCall(call, literals) {
  const args = argumentValues(call, literals)
  if (call.target.kind !== 'capability-member') {
    return processExit(args.code)
  }
  return invoke(call.target, args)
}

function argumentValues(call, literals) {
  const resolved = {}
  for (const [name, binding] of Object.entries(call.typedArguments ?? {})) {
    const literal = literals.get(binding.endpoint)
    resolved[name] = literal?.type === 'bytes' ? hexToBytes(literal.value) : literal?.value
  }
  return resolved
}

function invoke(target, args) {
  if (target.schemaReference === 'process.stdout@0.1.0' && target.member === 'write') {
    process.stdout.write(args.data)
    return ok(null)
  }
  if (target.schemaReference === 'process.args@0.1.0' && target.member === 'read') {
    return ok(process.argv.slice(2))
  }
  if (target.schemaReference === 'fs.read@0.1.0' && target.member === 'read_file') {
    const path = artifactPath(args.path)
    if (path === null) return err('fs.read_error', 'outside_sandbox')
    try {
      const bytes = readFileSync(path)
      return ok(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (error) {
      if (error.code === 'ENOENT') return err('fs.read_error', 'not_found')
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return err('fs.read_error', 'permission_denied')
      }
      if (error instanceof TypeError) return err('fs.read_error', 'invalid_utf8')
      return err('fs.read_error', 'io')
    }
  }
  if (target.schemaReference === 'fs.write@0.1.0' && target.member === 'write_file') {
    const path = artifactPath(args.path)
    if (path === null) return err('fs.write_error', 'outside_sandbox')
    try {
      writeFileSync(path, Buffer.from(args.data))
      return ok(null)
    } catch (error) {
      if (error.code === 'ENOENT') return err('fs.write_error', 'parent_not_found')
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return err('fs.write_error', 'permission_denied')
      }
      if (error.code === 'ENOSPC') return err('fs.write_error', 'no_space')
      return err('fs.write_error', 'io')
    }
  }
  throw new Error(\`unsupported operation: \${target.schemaReference}.\${target.member}\`)
}

function artifactPath(path) {
  if (typeof path !== 'string' || path.startsWith('/')) return null
  const resolved = resolve(here, path)
  return resolved === here || resolved.startsWith(here + sep) ? resolved : null
}

function processExit(code) {
  const numeric = Number(code)
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 255) {
    throw new Error('invalid process exit code')
  }
  return { code: numeric, type: 'process.status' }
}

function ok(value) {
  return { kind: 'value', value: { kind: 'ok', value } }
}

function err(type, variant) {
  return { kind: 'value', value: { error: { type, variant }, kind: 'err' } }
}

function hexToBytes(hex) {
  const bytes = []
  for (let index = 4; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16))
  }
  return bytes
}
`
}

function stripLocations(value) {
  if (Array.isArray(value)) {
    return value.map(stripLocations)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'location')
        .map(([key, nested]) => [key, stripLocations(nested)]),
    )
  }
  return value
}

function buildSemanticView(program, audit) {
  const revision = graphRevision(program)
  const main = program.functions.find((candidate) => candidate.name === '@main')
  const capabilityUids = new Map(
    program.capabilities.map((capability) => [capability.instance, capability.uid]),
  )
  const facts = [
    ...audit.capabilities.map((capability) => ({
      audit_category: 'capability',
      binding_kind: capability.binding_kind,
      evidence_uid: capabilityUids.get(capability.instance) ?? null,
      fact_id: `capability:${capability.instance}`,
      kind: 'capability',
      reference: capability.reference,
      revision,
      subject: capability.instance,
    })),
    ...audit.effects.map((effect) => ({
      access: [...effect.access].sort(compareUtf8),
      audit_category: 'effect',
      capability_instance: effect.capability_instance,
      evidence_uid: effect.node_uid,
      fact_id: `effect:${effect.node_uid}`,
      kind: 'effect',
      member: effect.member,
      result_consumers: [...effect.result_consumers].sort(compareUtf8),
      returns: effect.returns,
      revision,
      subject: effect.node_uid,
    })),
    ...audit.errorPaths.map((path) => ({
      audit_category: 'error_path',
      consumer_uid: path.consumer_uid,
      error_type: path.error_type,
      evidence_uid: path.producer_uid,
      fact_id: `error-path:${path.producer_uid}:${path.error_type}:${path.consumer_uid}`,
      kind: 'error_path',
      producer_uid: path.producer_uid,
      revision,
      status_codes: sortedUniqueNumbers(path.status_codes),
      subject: path.producer_uid,
    })),
    {
      audit_category: 'status_code',
      evidence_uid: main?.uid ?? null,
      fact_id: 'status-codes',
      kind: 'status_codes',
      revision,
      status_codes: sortedUniqueNumbers(audit.statusCodes),
      subject: main?.name ?? '@main',
    },
  ]
  return {
    facts: facts.sort((left, right) => compareFact(left, right)),
    locale: 'zh-CN',
    revision,
    schema: 're.semantic-view-ir@0.1.0',
    unit: program.unit,
  }
}

function renderTextView(view) {
  if (view.locale === 'en-US') return renderEnglishView(view)
  return renderChineseView(view)
}

function renderChineseView(view) {
  const factsByKind = groupedFacts(view)
  const lines = [
    'RE 语义视图 0.1',
    `单位：${view.unit}`,
    `图修订：${view.revision}`,
    '能力：',
    ...renderCapabilities(factsByKind.get('capability') ?? []),
    '效果：',
    ...renderEffects(factsByKind.get('effect') ?? []),
    '错误路径：',
    ...renderErrorPaths(factsByKind.get('error_path') ?? []),
    '退出码：',
    ...renderStatusCodes(factsByKind.get('status_codes') ?? []),
  ]
  return `${lines.join('\n')}\n`
}

function renderEnglishView(view) {
  const factsByKind = groupedFacts(view)
  const lines = [
    'RE Semantic View 0.1',
    `Unit: ${view.unit}`,
    `Graph revision: ${view.revision}`,
    'Capabilities:',
    ...renderEnglishCapabilities(factsByKind.get('capability') ?? []),
    'Effects:',
    ...renderEnglishEffects(factsByKind.get('effect') ?? []),
    'Error paths:',
    ...renderEnglishErrorPaths(factsByKind.get('error_path') ?? []),
    'Status codes:',
    ...renderStatusCodes(factsByKind.get('status_codes') ?? []),
  ]
  return `${lines.join('\n')}\n`
}

function renderHtmlView(view) {
  const factsByKind = groupedFacts(view)
  const capabilityRows = renderHtmlRows(
    factsByKind.get('capability') ?? [],
    (fact) => [
      fact.subject,
      fact.reference,
      fact.binding_kind,
      fact.evidence_uid,
      fact.fact_id,
    ],
  )
  const effectRows = renderHtmlRows(
    factsByKind.get('effect') ?? [],
    (fact) => [
      fact.subject,
      `${fact.capability_instance}.${fact.member}`,
      fact.access.join(', '),
      fact.returns,
      formatList(fact.result_consumers),
      fact.evidence_uid,
      fact.fact_id,
    ],
  )
  const errorRows = renderHtmlRows(
    factsByKind.get('error_path') ?? [],
    (fact) => [
      fact.producer_uid,
      fact.error_type,
      fact.consumer_uid,
      formatList(fact.status_codes),
      fact.evidence_uid,
      fact.fact_id,
    ],
  )
  const statusRows = renderHtmlRows(
    factsByKind.get('status_codes') ?? [],
    (fact) => [formatList(fact.status_codes), fact.evidence_uid, fact.fact_id],
  )
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>RE 语义视图 0.1 - ${escapeHtml(view.unit)}</title>
<style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45;color:#111827;background:#f8fafc}body{margin:0;padding:32px}main{max-width:1120px;margin:0 auto}h1{font-size:28px;margin:0 0 8px}p{margin:0 0 24px;color:#475569}.section{border-top:1px solid #cbd5e1;padding:20px 0}h2{font-size:16px;margin:0 0 12px}table{width:100%;border-collapse:collapse;font-size:13px;background:white}th,td{border-bottom:1px solid #e2e8f0;padding:8px 10px;text-align:left;vertical-align:top}th{color:#334155;background:#f1f5f9;font-weight:650}code{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px}@media (prefers-color-scheme:dark){:root{color:#e5e7eb;background:#0f172a}p{color:#94a3b8}table{background:#111827}th{color:#e2e8f0;background:#1f2937}th,td,.section{border-color:#334155}}</style>
</head>
<body>
<main data-schema="${escapeHtml(view.schema)}" data-revision="${escapeHtml(view.revision)}">
<h1>RE 语义视图 0.1</h1>
<p>单位：<code>${escapeHtml(view.unit)}</code> · 图修订：<code>${escapeHtml(view.revision)}</code></p>
${renderHtmlSection('能力', ['Subject', 'Reference', 'Binding', 'Evidence UID', 'Fact ID'], capabilityRows)}
${renderHtmlSection('效果', ['Subject', 'Call', 'Access', 'Returns', 'Consumers', 'Evidence UID', 'Fact ID'], effectRows)}
${renderHtmlSection('错误路径', ['Producer UID', 'Error Type', 'Consumer UID', 'Status Codes', 'Evidence UID', 'Fact ID'], errorRows)}
${renderHtmlSection('退出码', ['Status Codes', 'Evidence UID', 'Fact ID'], statusRows)}
</main>
</body>
</html>
`
}


function renderSvgView(view) {
  const rows = view.facts.map((fact) => ({
    evidence: fact.evidence_uid ?? '',
    factId: fact.fact_id,
    kind: fact.kind,
    summary: svgFactSummary(fact),
  }))
  const rowHeight = 34
  const rowStart = 160
  const height = rowStart + Math.max(rows.length, 1) * rowHeight + 28
  const rowElements = rows.length === 0
    ? `<text x="32" y="${rowStart}" class="muted">No facts</text>`
    : rows.map((row, index) => renderSvgFactRow(row, rowStart + index * rowHeight)).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="RE Semantic View 0.1" width="1120" height="${height}" viewBox="0 0 1120 ${height}" data-schema="${escapeXml(view.schema)}" data-revision="${escapeXml(view.revision)}">
<title>RE Semantic View 0.1 - ${escapeXml(view.unit)}</title>
<desc>Deterministic SVG rendering of ${escapeXml(view.schema)} for ${escapeXml(view.revision)}</desc>
<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:26px;font-weight:700;fill:#111827}.meta{font-size:12px;fill:#475569}.head{font-size:11px;font-weight:700;fill:#334155}.cell{font-size:12px;fill:#111827}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.muted{fill:#64748b}.rule{stroke:#cbd5e1;stroke-width:1}.row:nth-child(even) rect{fill:#f8fafc}.row:nth-child(odd) rect{fill:#ffffff}</style>
<rect width="1120" height="${height}" fill="#ffffff"/>
<text x="32" y="42" class="title">RE Semantic View 0.1</text>
<text x="32" y="68" class="meta mono">unit=${escapeXml(view.unit)}</text>
<text x="32" y="88" class="meta mono">revision=${escapeXml(view.revision)}</text>
<line x1="32" y1="104" x2="1088" y2="104" class="rule"/>
<text x="32" y="128" class="head">Kind</text>
<text x="150" y="128" class="head">Fact ID</text>
<text x="470" y="128" class="head">Evidence UID</text>
<text x="720" y="128" class="head">Summary</text>
${rowElements}
</svg>
`
}

function renderSvgFactRow(row, y) {
  return `<g class="row" data-fact-id="${escapeXml(row.factId)}" data-evidence-uid="${escapeXml(row.evidence)}">
<rect x="24" y="${y - 20}" width="1072" height="30" rx="0"/>
<text x="32" y="${y}" class="cell mono">${escapeXml(row.kind)}</text>
<text x="150" y="${y}" class="cell mono">${escapeXml(row.factId)}</text>
<text x="470" y="${y}" class="cell mono">${escapeXml(row.evidence)}</text>
<text x="720" y="${y}" class="cell">${escapeXml(row.summary)}</text>
</g>`
}

function svgFactSummary(fact) {
  if (fact.kind === 'capability') {
    return `${fact.subject} -> ${fact.reference} (${fact.binding_kind})`
  }
  if (fact.kind === 'effect') {
    return `${fact.subject} calls ${fact.capability_instance}.${fact.member}; ${fact.access.join(', ')}`
  }
  if (fact.kind === 'error_path') {
    return `${fact.producer_uid} ${fact.error_type} consumed by ${fact.consumer_uid}`
  }
  if (fact.kind === 'status_codes') {
    return `status ${formatList(fact.status_codes)}`
  }
  return fact.subject ?? fact.kind
}

function groupedFacts(view) {
  const factsByKind = new Map()
  for (const fact of view.facts) {
    const bucket = factsByKind.get(fact.kind) ?? []
    bucket.push(fact)
    factsByKind.set(fact.kind, bucket)
  }
  return factsByKind
}

function renderHtmlSection(title, headers, rows) {
  return `<section class="section"><h2>${escapeHtml(title)}</h2><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></section>`
}

function renderHtmlRows(facts, toCells) {
  if (facts.length === 0) return '<tr><td colspan="99">无</td></tr>'
  return facts
    .map((fact) => `<tr>${toCells(fact).map((cell) => `<td><code>${escapeHtml(cell ?? '')}</code></td>`).join('')}</tr>`)
    .join('')
}

function escapeHtml(value) {
  return escapeXml(value)
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\"', '&quot;')
}

function renderCapabilities(facts) {
  if (facts.length === 0) return ['- 无']
  return facts.map((fact) =>
    `- ${fact.subject} 使用 ${fact.reference}（${fact.binding_kind}，证据 ${fact.evidence_uid}）`,
  )
}

function renderEnglishCapabilities(facts) {
  if (facts.length === 0) return ['- None']
  return facts.map((fact) =>
    `- ${fact.subject} uses ${fact.reference} (${fact.binding_kind}, evidence ${fact.evidence_uid})`,
  )
}

function renderEffects(facts) {
  if (facts.length === 0) return ['- 无']
  return facts.map((fact) =>
    `- ${fact.subject} 调用 ${fact.capability_instance}.${fact.member}；访问 ${fact.access.join('、')}；返回 ${fact.returns}；消费者 ${formatList(fact.result_consumers)}`,
  )
}

function renderEnglishEffects(facts) {
  if (facts.length === 0) return ['- None']
  return facts.map((fact) =>
    `- ${fact.subject} calls ${fact.capability_instance}.${fact.member}; access ${fact.access.join(', ')}; returns ${fact.returns}; consumers ${formatList(fact.result_consumers)}`,
  )
}

function renderErrorPaths(facts) {
  if (facts.length === 0) return ['- 无']
  return facts.map((fact) =>
    `- ${fact.producer_uid} 的 ${fact.error_type} 由 ${fact.consumer_uid} 消费；可能退出 ${formatList(fact.status_codes)}`,
  )
}

function renderEnglishErrorPaths(facts) {
  if (facts.length === 0) return ['- None']
  return facts.map((fact) =>
    `- ${fact.producer_uid} ${fact.error_type} is consumed by ${fact.consumer_uid}; possible exit ${formatList(fact.status_codes)}`,
  )
}

function renderStatusCodes(facts) {
  const codes = facts.flatMap((fact) => fact.status_codes)
  return [`- ${formatList(sortedUniqueNumbers(codes))}`]
}

function formatList(values) {
  return values.length === 0 ? '无' : values.join(', ')
}

function compareFact(left, right) {
  return (
    compareUtf8(left.kind, right.kind)
    || compareUtf8(left.fact_id, right.fact_id)
  )
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function sortedUniqueNumbers(values) {
  return [...new Set(values)].sort((left, right) => left - right)
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalSha256(value) {
  return `sha256:${sha256Hex(Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8'))}`
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

function bindingKind(reference) {
  if (reference.startsWith('process.')) return 'memory'
  if (reference.startsWith('fs.')) return 'local'
  return 'unbound'
}

function schemaMember(reference, memberName) {
  const resolved = loadedRegistry.value.resolve(reference)
  if (!resolved.ok) throw new Error(`checked graph references missing schema ${reference}`)
  const member = resolved.value.members[memberName]
  if (member === undefined) {
    throw new Error(`checked graph references missing schema member ${reference}.${memberName}`)
  }
  return member
}

function resultErrorType(returnType) {
  const match = /^result<[^,]+, ([^>]+)>$/.exec(returnType)
  return match?.[1] ?? null
}

function processExitCode(call, literalsByUid) {
  if (
    call.target.kind !== 'pure-operation'
    || call.target.operation !== 'process.exit'
  ) {
    return null
  }
  const endpoint = call.typedArguments?.code?.endpoint
  if (endpoint === undefined) return null
  const literal = literalsByUid.get(endpoint)
  return literal === undefined ? null : Number(BigInt(literal.value))
}
