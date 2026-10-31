import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { demoSchemaDefinitions } from '../src/host/demo-schema.js'
import { HostEnvironment } from '../src/host/host-environment.js'
import { ServerHttpClientTransportAdapter } from '../src/host/server-http-client-transport-adapter.js'
import { createServerHttpClientFetchTransport } from '../src/host/server-http-client-fetch-transport.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'
import { serverProfileSchemaDefinitions } from '../src/host/server-profile.js'
import {
  createRuntimeEffectReceiptRecorder,
  verifyRuntimeEffectReceipt,
} from '../src/host/runtime-effect-receipt.js'
import {
  checkSource,
  reviewSource,
  runSourceWithRuntimeEffectReceipt,
  translateSource,
  viewSource,
} from '../src/toolchain/demo-toolchain.js'
import { evaluateProgramWithRuntimeEffectReceipt } from '../src/toolchain/evaluator.js'
import { graphRevision } from '../src/toolchain/structured-patch.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI = join(ROOT, 'src/cli/re.js')
const DIGEST = `sha256:${'a'.repeat(64)}`

const argsSource = `re 0.1 compact
unit @args
cap @args: process.args@0.1.0
fn @main() -> process.status {
  %args = @args.read()
  return match %args {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}`

function uidFactory(start) {
  let counter = start
  return () => {
    let value = counter
    counter += 1
    let prefix = ''
    for (let index = 0; index < 7; index += 1) {
      prefix = 'abcdefghijklmnopqrstuvwxyz234567'[value % 32] + prefix
      value = Math.floor(value / 32)
    }
    return `${prefix}${'a'.repeat(19)}`
  }
}

function responseValue(observation) {
  return observation.response.kind === 'value'
    ? observation.response.value
    : observation.response
}

test('runtime receipts capture exact success and failure observations for demo capabilities', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-runtime-effects-'))
  t.after(() => rm(root, { force: true, recursive: true }))

  const argsOk = runSourceWithRuntimeEffectReceipt(argsSource, {
    argv: ['alpha', 'β'],
    file: join(root, 'args.re'),
  })
  assert.equal(argsOk.outcome.status.code, 0)
  assert.deepEqual(responseValue(argsOk.runtime_effect_receipt.observations[0]), {
    kind: 'ok',
    value: ['alpha', 'β'],
  })

  const argsError = runSourceWithRuntimeEffectReceipt(argsSource, {
    argv: [Uint8Array.of(0xff)],
    file: join(root, 'args-invalid.re'),
  })
  assert.equal(argsError.outcome.status.code, 1)
  assert.deepEqual(responseValue(argsError.runtime_effect_receipt.observations[0]), {
    error: { type: 'process.args_error', variant: 'invalid_utf8' },
    kind: 'err',
  })

  const hello = await readFile(join(ROOT, 'examples/hello.re'), 'utf8')
  const stdout = []
  const stdoutOk = runSourceWithRuntimeEffectReceipt(hello, {
    file: join(root, 'stdout.re'),
    host: { stdout },
  })
  assert.equal(stdoutOk.outcome.status.code, 0)
  assert.deepEqual(stdout, ['Hello, World!\n'])
  assert.deepEqual(stdoutOk.runtime_effect_receipt.observations[0].arguments, {
    data: 'Hello, World!\n',
  })
  assert.deepEqual(responseValue(stdoutOk.runtime_effect_receipt.observations[0]), {
    kind: 'ok',
    value: null,
  })

  const stdoutFailure = runSourceWithRuntimeEffectReceipt(hello, {
    file: join(root, 'stdout-failure.re'),
    host: { stdoutBroken: true },
  })
  assert.equal(stdoutFailure.outcome.status.code, 1)
  assert.deepEqual(responseValue(stdoutFailure.runtime_effect_receipt.observations[0]), {
    error: { type: 'io.write_error', variant: 'broken_pipe' },
    kind: 'err',
  })

  await writeFile(join(root, 'input.txt'), Buffer.from([0xff]))
  const readSource = await readFile(join(ROOT, 'examples/read-check.re'), 'utf8')
  const readOk = runSourceWithRuntimeEffectReceipt(readSource, {
    file: join(root, 'read.re'),
    fileSandboxRoot: root,
  })
  assert.equal(readOk.outcome.status.code, 2)
  assert.deepEqual(responseValue(readOk.runtime_effect_receipt.observations[0]), {
    error: { type: 'fs.read_error', variant: 'invalid_utf8' },
    kind: 'err',
  })

  const validText = 'read me exactly'
  await writeFile(join(root, 'input.txt'), validText, 'utf8')
  const textReadOk = runSourceWithRuntimeEffectReceipt(readSource, {
    file: join(root, 'read-success.re'),
    fileSandboxRoot: root,
  })
  assert.deepEqual(responseValue(textReadOk.runtime_effect_receipt.observations[0]), {
    kind: 'ok',
    value: validText,
  })

  await rm(join(root, 'input.txt'))
  const missingRead = runSourceWithRuntimeEffectReceipt(readSource, {
    file: join(root, 'missing-read.re'),
    fileSandboxRoot: root,
  })
  assert.deepEqual(responseValue(missingRead.runtime_effect_receipt.observations[0]), {
    error: { type: 'fs.read_error', variant: 'not_found' },
    kind: 'err',
  })

  const writeSource = await readFile(join(ROOT, 'examples/write-check.re'), 'utf8')
  const writeOk = runSourceWithRuntimeEffectReceipt(writeSource, {
    file: join(root, 'write.re'),
    fileSandboxRoot: root,
  })
  assert.deepEqual(
    await readFile(join(root, 'output.txt')),
    Buffer.from([0x41, 0x00, 0x42]),
  )
  assert.deepEqual(writeOk.runtime_effect_receipt.observations[0].arguments, {
    data: { kind: 'bytes', hex: '410042' },
    path: 'output.txt',
  })
  assert.deepEqual(responseValue(writeOk.runtime_effect_receipt.observations[0]), {
    kind: 'ok',
    value: null,
  })

  const rejectedWrite = runSourceWithRuntimeEffectReceipt(
    writeSource.replace('"output.txt"', '"../outside.txt"'),
    {
      file: join(root, 'write-rejected.re'),
      fileSandboxRoot: root,
    },
  )
  assert.deepEqual(responseValue(rejectedWrite.runtime_effect_receipt.observations[0]), {
    error: { type: 'fs.write_error', variant: 'outside_sandbox' },
    kind: 'err',
  })
  await assert.rejects(readFile(join(root, '..', 'outside.txt')))
})

test('pure std operations and process.exit produce no runtime effect receipt', async (t) => {
  const pureSource = (bytes) => `re 0.1 canonical
unit @pure_exit
fn %uaaaaaab: uid("aaaaaabaaaaaaaaaaaaaaaaaaa"): @main -> process.status {
  literal %uaaaaaae: uid("aaaaaaeaaaaaaaaaaaaaaaaaaa"): bytes = ${bytes}
  literal %uaaaaaaj: uid("aaaaaajaaaaaaaaaaaaaaaaaaa"): int = 0
  literal %uaaaaaam: uid("aaaaaamaaaaaaaaaaaaaaaaaaa"): int = 1
  let %uaaaaaac: uid("aaaaaacaaaaaaaaaaaaaaaaaaa"): %decoded = call %uaaaaaad: uid("aaaaaadaaaaaaaaaaaaaaaaaaa"): std.bytes.decode_utf8@0.1.0(value: %uaaaaaae)
  return %uaaaaaaf: uid("aaaaaafaaaaaaaaaaaaaaaaaaa"): match %uaaaaaag: uid("aaaaaagaaaaaaaaaaaaaaaaaaa"): %uaaaaaac {
    branch %uaaaaaak: uid("aaaaaakaaaaaaaaaaaaaaaaaaa"): err => call %uaaaaaal: uid("aaaaaalaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaam)
    branch %uaaaaaah: uid("aaaaaahaaaaaaaaaaaaaaaaaaa"): ok => call %uaaaaaai: uid("aaaaaaiaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaaj)
  }
}
`
  const root = await mkdtemp(join(tmpdir(), 're-pure-effect-receipt-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  for (const [bytes, status] of [['hex:6f6b', 0], ['hex:ff', 1]]) {
    const file = join(root, `pure-${status}.re`)
    await writeFile(file, pureSource(bytes), 'utf8')
    const result = spawnSync(process.execPath, [
      CLI,
      'run',
      '--format',
      'json',
      '--runtime-receipt',
      file,
    ], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(result.status, status, result.stderr)
    const envelope = JSON.parse(result.stdout)
    assert.equal(envelope.schema, 're.run-result@0.2.0')
    assert.equal(envelope.runtime_effect_receipt, null)
  }

  const malformed = runSourceWithRuntimeEffectReceipt(
    're 0.1 compact\nunit @bad\nfn @main() -> process.status {\n  return process.exit(256)\n}',
    { file: 'bad-exit.re' },
  )
  assert.equal(malformed.outcome.kind, 'check-failure')
  assert.equal(malformed.runtime_effect_receipt, null)
})

test('runtime demand identities survive unrelated UID allocation and fresh CLI processes', () => {
  const hello = readFileSync(join(ROOT, 'examples/hello.re'), 'utf8')
  const firstProgram = checkSource(hello, {
    file: 'stable.re',
    uidFactory: uidFactory(0),
  })
  const secondProgram = checkSource(hello, {
    file: 'stable.re',
    uidFactory: uidFactory(500),
  })
  assert.equal(firstProgram.ok, true)
  assert.equal(secondProgram.ok, true)
  assert.notEqual(
    firstProgram.program.functions[0].statements[0].uid,
    secondProgram.program.functions[0].statements[0].uid,
  )

  const first = evaluateProgramWithRuntimeEffectReceipt(firstProgram.program, {
    stdout: [],
  })
  const second = evaluateProgramWithRuntimeEffectReceipt(secondProgram.program, {
    stdout: [],
  })
  const firstObservation = first.runtime_effect_receipt.observations[0]
  const secondObservation = second.runtime_effect_receipt.observations[0]
  assert.notEqual(
    first.runtime_effect_receipt.graph_revision,
    second.runtime_effect_receipt.graph_revision,
  )
  assert.equal(firstObservation.demand_id, secondObservation.demand_id)
  assert.equal(firstObservation.receipt_id, secondObservation.receipt_id)
  assert.notEqual(firstObservation.effect_uid, secondObservation.effect_uid)

  const run = () => {
    const child = spawnSync(process.execPath, [
      CLI, 'run', '--format', 'json', '--runtime-receipt',
      join(ROOT, 'examples/hello.re'),
    ], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    return JSON.parse(child.stdout)
  }
  const childFirst = run()
  const childSecond = run()
  assert.equal(childFirst.schema, 're.run-result@0.2.0')
  assert.deepEqual(
    verifyRuntimeEffectReceipt(childFirst.runtime_effect_receipt, {
      graphRevision: childFirst.runtime_effect_receipt.graph_revision,
    }),
    { ok: true },
  )
  assert.deepEqual(
    childFirst.runtime_effect_receipt,
    childSecond.runtime_effect_receipt,
  )
  const modifiedReceipt = structuredClone(childFirst.runtime_effect_receipt)
  modifiedReceipt.observations[0].response.value.value = 'forged'
  assert.deepEqual(
    verifyRuntimeEffectReceipt(modifiedReceipt),
    { code: 'runtime-effect-receipt-digest-mismatch', ok: false },
  )
  assert.deepEqual(
    verifyRuntimeEffectReceipt(childFirst.runtime_effect_receipt, {
      graphRevision: DIGEST,
    }),
    { code: 'runtime-effect-receipt-graph-revision-mismatch', ok: false },
  )
})

test('repeated equivalent host demands retain multiplicity with stable occurrence identities', () => {
  const recorder = createRuntimeEffectReceiptRecorder(DIGEST)
  for (let sequence = 0; sequence < 2; sequence += 1) {
    const token = recorder.beginInvocation({
      arguments: { data: 'same payload' },
      effect_uid: `unrelated-call-${sequence}`,
      instance: '@stdout',
      member: 'write',
      reference: 'process.stdout@0.1.0',
      sequence,
    })
    recorder.completeInvocation(token, {
      kind: 'value',
      value: { kind: 'ok', value: null },
    })
  }
  const receipt = recorder.toReceipt()
  assert.deepEqual(verifyRuntimeEffectReceipt(receipt), { ok: true })
  assert.equal(receipt.observations.length, 2)
  assert.deepEqual(
    receipt.observations.map(({ occurrence }) => occurrence),
    [0, 1],
  )
  assert.notEqual(
    receipt.observations[0].demand_id,
    receipt.observations[1].demand_id,
  )
  assert.notEqual(
    receipt.observations[0].effect_uid,
    receipt.observations[1].effect_uid,
  )
})

test('check, manifest, translation, and view preserve one checked effect identity', () => {
  const source = readFileSync(join(ROOT, 'examples/hello.re'), 'utf8')
  const checked = checkSource(source, { file: 'hello.re' })
  const manifest = reviewSource(source, { file: 'hello.re' })
  const translation = translateSource(source, { file: 'hello.re' })
  const view = viewSource(source, { file: 'hello.re', locale: 'en-US' })
  assert.equal(checked.ok, true)
  assert.equal(manifest.ok, true)
  assert.equal(translation.ok, true)
  assert.equal(view.ok, true)

  const sourceCall = checked.program.functions[0].statements[0].value
  const sourceCapability = checked.program.capabilities[0]
  const manifestEffect = manifest.value.effects.find(
    ({ call_uid: callUid }) => callUid === sourceCall.uid,
  )
  const viewEffect = view.value.semanticView.facts.find(
    (fact) => fact.kind === 'effect' && fact.evidence_uid === sourceCall.uid,
  )
  const viewCapability = view.value.semanticView.facts.find(
    (fact) => fact.kind === 'capability'
      && fact.evidence_uid === sourceCapability.uid,
  )
  const canonical = translation.value.canonical.bytes

  assert.equal(sourceCall.target.schemaReference, 'process.stdout@0.1.0')
  assert.equal(sourceCapability.reference, manifest.value.capabilities[0].reference)
  assert.equal(manifestEffect.member, sourceCall.target.member)
  assert.equal(manifestEffect.schema_reference, sourceCall.target.schemaReference)
  assert.equal(manifest.value.graph_revision, translation.value.graph_revision)
  assert.equal(translation.value.graph_revision, view.value.semanticView.revision)
  assert.match(canonical, /@stdout\.write/u)
  assert.equal(viewEffect.capability_instance, sourceCall.target.instance)
  assert.equal(viewEffect.member, sourceCall.target.member)
  assert.equal(viewCapability.reference, sourceCapability.reference)
  const execution = runSourceWithRuntimeEffectReceipt(source, { file: 'hello.re' })
  const observedEffect = execution.runtime_effect_receipt.observations[0]
  assert.equal(observedEffect.effect_uid, sourceCall.uid)
  assert.equal(observedEffect.effect_uid, manifestEffect.call_uid)
  assert.equal(observedEffect.effect_uid, viewEffect.evidence_uid)
})

test('receipt capture faults cannot suppress or replace a host invocation', () => {
  const registry = SchemaRegistry.load(demoSchemaDefinitions())
  assert.equal(registry.ok, true)
  let adapterCalls = 0
  const adapter = {
    supportedInterfaces: () => ['process.stdout@0.1.0'],
    invoke: () => {
      adapterCalls += 1
      return {
        kind: 'value',
        value: { kind: 'ok', value: null },
      }
    },
  }
  let invalidated = false
  const bound = HostEnvironment.bind({
    bindings: [{ adapter, instance: '@stdout' }],
    capabilities: [{
      instance: '@stdout',
      reference: 'process.stdout@0.1.0',
    }],
    onInvocation: {
      beginInvocation() {
        throw new Error('observer failed')
      },
      completeInvocation() {},
      invalidate() {
        invalidated = true
      },
    },
    registry: registry.value,
  })
  assert.equal(bound.ok, true)
  assert.deepEqual(bound.value.invoke('@stdout', 'write', {
    data: 'payload',
  }, 'write-uid'), {
    kind: 'value',
    value: { kind: 'ok', value: null },
  })
  assert.equal(adapterCalls, 1)
  assert.equal(invalidated, true)
})

test('runtime receipt records sanitized adapter faults instead of raw exception details', async () => {
  const registry = SchemaRegistry.load(demoSchemaDefinitions())
  assert.equal(registry.ok, true)
  const checked = checkSource(await readFile(join(ROOT, 'examples/hello.re'), 'utf8'))
  assert.equal(checked.ok, true)
  const recorder = createRuntimeEffectReceiptRecorder(graphRevision(checked.program))
  // Bind a second HostEnvironment with the receipt observer at construction time.
  const observed = HostEnvironment.bind({
    bindings: [{
      adapter: {
        supportedInterfaces: () => ['process.stdout@0.1.0'],
        invoke: () => { throw new Error('private socket token detail') },
      },
      instance: '@stdout',
    }],
    capabilities: [{
      instance: '@stdout',
      reference: 'process.stdout@0.1.0',
    }],
    onInvocation: recorder,
    registry: registry.value,
  })
  assert.equal(observed.ok, true)
  const response = observed.value.invoke('@stdout', 'write', {
    data: 'public text',
  }, 'call-uid', 'effect-uid')
  assert.equal(response.kind, 'host-fault')
  const receipt = recorder.toReceipt()
  assert.equal(receipt.observations[0].response.fault.code, 'host-contract-violation')
  assert.equal(
    JSON.stringify(receipt).includes('private socket token detail'),
    false,
  )
  assert.equal(verifyRuntimeEffectReceipt(receipt).ok, true)
})

test('host invocation observation hooks are snapshotted at bind time', () => {
  const registry = SchemaRegistry.load(demoSchemaDefinitions())
  let adapterCalls = 0
  let originalBegins = 0
  let originalCompletes = 0
  let hookReads = 0
  let beginHook = () => {
    originalBegins += 1
    return 0
  }
  let completeHook = () => { originalCompletes += 1 }
  let invalidateHook = () => {}
  const observer = {
    get beginInvocation() {
      hookReads += 1
      return beginHook
    },
    set beginInvocation(value) {
      beginHook = value
    },
    get completeInvocation() {
      hookReads += 1
      return completeHook
    },
    set completeInvocation(value) {
      completeHook = value
    },
    get invalidate() {
      hookReads += 1
      return invalidateHook
    },
    set invalidate(value) {
      invalidateHook = value
    },
  }
  const bound = HostEnvironment.bind({
    bindings: [{
      adapter: {
        supportedInterfaces: () => ['process.stdout@0.1.0'],
        invoke: () => {
          adapterCalls += 1
          return {
            kind: 'value',
            value: { kind: 'ok', value: null },
          }
        },
      },
      instance: '@stdout',
    }],
    capabilities: [{
      instance: '@stdout',
      reference: 'process.stdout@0.1.0',
    }],
    onInvocation: observer,
    registry: registry.value,
  })
  assert.equal(bound.ok, true)
  observer.beginInvocation = () => { throw new Error('replacement hook used') }
  observer.completeInvocation = () => { throw new Error('replacement hook used') }
  assert.deepEqual(bound.value.invoke('@stdout', 'write', {
    data: 'payload',
  }, 'write-uid'), {
    kind: 'value',
    value: { kind: 'ok', value: null },
  })
  assert.equal(hookReads, 3)
  assert.equal(originalBegins, 1)
  assert.equal(originalCompletes, 1)
  assert.equal(adapterCalls, 1)
})

test('runtime effect receipt observes a real loopback HTTP request and connection refusal', async (t) => {
  const requests = []
  let activeRequests = 0
  let peakRequests = 0
  const server = createServer(async (request, response) => {
    activeRequests += 1
    peakRequests = Math.max(peakRequests, activeRequests)
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({
      body: Buffer.concat(chunks),
      method: request.method,
      path: request.url,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('loopback-ok')
    activeRequests -= 1
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  ))))

  const address = server.address()
  const registry = SchemaRegistry.load(serverProfileSchemaDefinitions())
  assert.equal(registry.ok, true)
  const recorder = createRuntimeEffectReceiptRecorder(DIGEST)
  const bound = HostEnvironment.bind({
    bindings: [{
      adapter: new ServerHttpClientTransportAdapter({
        transport: createServerHttpClientFetchTransport(),
      }),
      instance: '@http',
    }],
    capabilities: [{
      instance: '@http',
      reference: 'http.client@0.1.0',
    }],
    onInvocation: recorder,
    registry: registry.value,
  })
  assert.equal(bound.ok, true)
  const request = {
    body: Uint8Array.of(0x70, 0x69, 0x6e, 0x67),
    deadline: 1000,
    headers: 'x-runtime-test:exact',
    method: 'POST',
    redirect_policy: 'follow',
    url: `http://127.0.0.1:${address.port}/ok`,
  }
  assert.deepEqual(await bound.value.invokeAsync(
    '@http',
    'request',
    request,
    'http-call-uid-1',
  ), {
    kind: 'value',
    value: { kind: 'ok', value: '{"status":200,"body":"loopback-ok"}' },
  })

  assert.deepEqual(await bound.value.invokeAsync(
    '@http',
    'request',
    { ...request, url: 'http://127.0.0.1:1/unavailable' },
    'http-call-uid-2',
  ), {
    kind: 'value',
    value: {
      error: { type: 'http.client_error', variant: 'unavailable' },
      kind: 'err',
    },
  })
  assert.deepEqual(requests, [{
    body: Buffer.from('ping'),
    method: 'POST',
    path: '/ok',
  }])
  assert.equal(peakRequests, 1)
  const receipt = recorder.toReceipt()
  assert.equal(receipt.observations.length, 2)
  assert.deepEqual(receipt.observations.map(({ sequence }) => sequence), [0, 1])
  assert.deepEqual(
    receipt.observations.map(({ sequence, response }) => ({
      response: response.value?.kind === 'err'
        ? response.value.error.variant
        : response.value?.value,
      sequence,
    })),
    [
      { response: '{"status":200,"body":"loopback-ok"}', sequence: 0 },
      { response: 'unavailable', sequence: 1 },
    ],
  )
  assert.deepEqual(receipt.observations[0].arguments.body, {
    hex: '70696e67',
    kind: 'bytes',
  })
})

test('CLI receipt opt-in leaves the default JSON envelope unchanged and emits no receipt for pure runs', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const ordinary = run('run', '--format', 'json', join(ROOT, 'examples/hello.re'))
  const observed = run(
    'run',
    '--format',
    'json',
    '--runtime-receipt',
    join(ROOT, 'examples/hello.re'),
  )
  const pure = run(
    'run',
    '--format',
    'json',
    '--runtime-receipt',
    join(ROOT, 'test/fixtures/wrong-argument.re'),
  )

  assert.equal(ordinary.status, 0)
  assert.equal(JSON.parse(ordinary.stdout).schema, 're.run-result@0.1.0')
  assert.equal(observed.status, 0)
  assert.equal(JSON.parse(observed.stdout).schema, 're.run-result@0.2.0')
  assert.equal(JSON.parse(observed.stdout).runtime_effect_receipt.schema, 're.runtime-effect-receipt@0.1.0')
  assert.equal(JSON.parse(observed.stdout).runtime_effect_receipt.observations.length, 1)
  assert.equal(JSON.parse(observed.stdout).runtime_effect_receipt.observations[0].member, 'write')

  const args = run(
    'run',
    '--format',
    'json',
    '--runtime-receipt',
    join(ROOT, 'examples/args-check.re'),
    '--',
    'alpha',
    'β',
  )
  assert.equal(args.status, 0)
  assert.deepEqual(
    JSON.parse(args.stdout).runtime_effect_receipt.observations[0].response.value,
    { kind: 'ok', value: ['alpha', 'β'] },
  )

  const actualProcessStdout = spawnSync(process.execPath, [
    CLI,
    'run',
    join(ROOT, 'examples/hello.re'),
  ], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(actualProcessStdout.status, 0)
  assert.equal(actualProcessStdout.stdout, 'Hello, World!\n')

  assert.equal(pure.status, 65)
  assert.equal(JSON.parse(pure.stdout).runtime_effect_receipt, null)
})
