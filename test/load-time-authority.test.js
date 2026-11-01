import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createLoadTimeAuthorityPin,
  executeWithLoadTimeAuthority,
  verifyLoadTimeAuthority,
} from '../src/toolchain/load-time-authority.js'
import {
  checkSource,
  runSourceFromLoadedBytesWithAuthority,
} from '../src/toolchain/demo-toolchain.js'
import { translateCheckedGraph } from '../src/toolchain/translation-artifact.js'

const SOURCE = Buffer.from('re 0.1 canonical\nunit @main\n', 'utf8')
const GRAPH = { graph_revision: `sha256:${'1'.repeat(64)}` }
const ARTIFACT = Buffer.from('artifact-v1', 'utf8')
const RUNTIME = {
  interpreter: 're-node-reference',
  version: '0.1.0',
}
const COMMAND = {
  argv: ['re', 'run', '--format', 'json'],
  cwd: '.',
}
const ENVIRONMENT = {
  input: { mode: 'test', seed: 'fixed' },
}
const LOAD_PROCESS = {
  kind: 'source-to-interpreter',
  loader: 're.loader@0.1.0',
}
const RESULT = {
  status: 'succeeded',
  value: { ok: true },
}
const CORPUS = JSON.parse(readFileSync(
  new URL('./fixtures/load-time-authority.json', import.meta.url),
  'utf8',
))

function pin(runtimeResult = null) {
  return createLoadTimeAuthorityPin({
    reviewedSource: SOURCE,
    canonicalGraph: GRAPH,
    buildArtifact: ARTIFACT,
    runtime: RUNTIME,
    command: COMMAND,
    environment: ENVIRONMENT,
    loadProcess: LOAD_PROCESS,
    runtimeResult,
  })
}

function actual(overrides = {}) {
  const reviewed = pin()
  return {
    reviewedSource: SOURCE,
    canonicalGraph: GRAPH,
    buildArtifact: ARTIFACT,
    loadedBytes: SOURCE,
    runtime: RUNTIME,
    command: COMMAND,
    environment: ENVIRONMENT,
    loadProcess: reviewed.value.load_process,
    canonicalization: 're.canonical-json@1',
    runtimeResult: RESULT,
    ...overrides,
  }
}

test('clean authority verifies the reviewed and loaded execution identity', () => {
  assert.equal(CORPUS.schema, 're.load-time-authority-corpus@0.1.0')
  const reviewed = pin()
  assert.equal(reviewed.ok, true)
  const verification = verifyLoadTimeAuthority({
    pin: reviewed.value,
    actual: actual(),
  })
  assert.deepEqual(verification, {
    ok: true,
    status: 'VERIFIED',
  })
})

test('missing canonicalization is rejected before execution', () => {
  const reviewed = pin()
  const observed = actual()
  delete observed.canonicalization
  assert.deepEqual(
    verifyLoadTimeAuthority({
      pin: reviewed.value,
      actual: observed,
    }),
    {
      code: 'load-time-authority-actual-incomplete',
      ok: false,
    },
  )
})

test('source mutation and artifact replacement return DRIFTED', () => {
  const reviewed = pin()
  for (const mutated of [
    { loadedBytes: Buffer.from(`${SOURCE}mutated`, 'utf8') },
    { buildArtifact: Buffer.from('artifact-replaced', 'utf8') },
  ]) {
    assert.deepEqual(
      verifyLoadTimeAuthority({
        pin: reviewed.value,
        actual: actual(mutated),
      }),
      {
        code: 'DRIFTED',
        field: Object.hasOwn(mutated, 'loadedBytes')
          ? 'loaded_bytes'
          : 'build_artifact',
        ok: false,
        status: 'DRIFTED',
      },
    )
  }
})

test('runtime and canonicalization drift fail closed', () => {
  const reviewed = pin()
  assert.deepEqual(
    verifyLoadTimeAuthority({
      pin: reviewed.value,
      actual: actual({ runtime: { ...RUNTIME, version: '0.1.1' } }),
    }),
    {
      code: 'DRIFTED',
      field: 'runtime',
      ok: false,
      status: 'DRIFTED',
    },
  )
  assert.deepEqual(
    verifyLoadTimeAuthority({
      pin: reviewed.value,
      actual: actual({ canonicalization: 're.canonical-json@2' }),
    }),
    {
      code: 'load-time-canonicalization-drift',
      field: 'canonicalization',
      ok: false,
      status: 'DRIFTED',
    },
  )
})

test('load-process authority drift fails closed', () => {
  const reviewed = pin()
  assert.deepEqual(
    verifyLoadTimeAuthority({
      pin: reviewed.value,
      actual: actual({
        loadProcess: {
          ...LOAD_PROCESS,
          loader: 're.loader@9.0.0',
        },
      }),
    }),
    {
      code: 'DRIFTED',
      field: 'load_process',
      ok: false,
      status: 'DRIFTED',
    },
  )
})

test('effect cannot run before authority verification', () => {
  const reviewed = pin()
  let effects = 0
  const result = executeWithLoadTimeAuthority({
    pin: reviewed.value,
    actual: actual({ loadedBytes: Buffer.from(`${SOURCE}mutated`, 'utf8') }),
    effect() {
      effects += 1
      return 'must-not-run'
    },
  })
  assert.deepEqual(result, {
    code: 'DRIFTED',
    field: 'loaded_bytes',
    ok: false,
    status: 'DRIFTED',
  })
  assert.equal(effects, 0)
})

test('authority pin digest is consistency evidence, not a runtime result claim', () => {
  const reviewed = pin(RESULT)
  assert.match(reviewed.value.pin_digest, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(
    reviewed.value.pin_digest,
    `sha256:${createHash('sha256')
      .update(reviewed.value.canonical_bytes, 'utf8')
      .digest('hex')}`,
  )
  assert.equal(verifyLoadTimeAuthority({
    pin: reviewed.value,
    actual: actual({ runtimeResult: { status: 'failed' } }),
  }).field, 'runtime_result')
})

test('the loader snapshot reaches runtime only after authority verification', async () => {
  const source = Buffer.from(
    await (await import('node:fs/promises')).readFile(
      new URL('../examples/hello.re', import.meta.url),
    ),
  )
  const checked = checkSource(source.toString('utf8'), { file: 'hello.re' })
  assert.equal(checked.ok, true)
  const translated = translateCheckedGraph(checked.program)
  assert.equal(translated.ok, true)
  const authority = createLoadTimeAuthorityPin({
    reviewedSource: source,
    canonicalGraph: checked.program,
    buildArtifact: Buffer.from(translated.value.canonical.bytes, 'utf8'),
    runtime: {
      interpreter: 're-node-reference',
      version: process.version,
    },
    command: { argv: [], file: 'hello.re' },
    environment: { argv: [] },
    loadProcess: {
      kind: 'source-to-interpreter',
      loader: 're.loader@0.1.0',
    },
  })
  assert.equal(authority.ok, true)

  const clean = runSourceFromLoadedBytesWithAuthority(source, {
    authorityPin: authority.value,
    file: 'hello.re',
  })
  assert.equal(clean.outcome.kind, 'process-status')
  assert.equal(clean.programStdout, 'Hello, World!\n')

  const mutated = Buffer.from(`${source}mutated`, 'utf8')
  const drifted = runSourceFromLoadedBytesWithAuthority(mutated, {
    authorityPin: authority.value,
    file: 'hello.re',
  })
  assert.deepEqual(drifted.outcome, {
    fault: {
      code: 'DRIFTED',
      field: 'reviewed_source',
      phase: 'load-time-authority',
    },
    kind: 'host-fault',
  })
  assert.equal(drifted.programStdout, '')
})
