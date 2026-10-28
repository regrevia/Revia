import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { lowerModuleSurface } from '../src/toolchain/module-surface.js'

const manifest = JSON.parse(await readFile(
  new URL('./fixtures/module-contract-corpus.json', import.meta.url),
  'utf8',
)).manifest
const interfaceDigest = 'sha256:6cbfa0a9e364b386c5f6015b90a3bc4d962062b4ba553ad25e43f0bcf03fe71c'
const logDigest = 'sha256:7c1db8f3affe2264d5e0dfec3045aad064e881ab78c2b1f86b817895154050aa'

test('module review declarations lower source-owned facts independent of declaration order', () => {
  const declarations = [
    `capability agent.relay.api.log write log.write@0.1.0 uid ${uid('a')}`,
    `error agent.relay.api.error uid ${uid('2')}`,
    `state ready uid ${uid('o')}`,
    `task agent.relay.api.task id ${digest('a')}`,
    `edge agent.relay.api.input -> agent.relay.api.output uid ${uid('h')}`,
  ]
  const first = lowerModuleSurface(source(declarations), manifest)
  const reordered = lowerModuleSurface(source([...declarations].reverse()), manifest)

  assert.equal(first.ok, true)
  assert.deepEqual(reordered, first)
  assert.deepEqual(first.value.capabilities, [{
    instance: 'agent.relay.api.log',
    member: 'write',
    reference: 'log.write@0.1.0',
    uid: uid('a'),
  }])
  assert.deepEqual(first.value.errors, [{
    name: 'agent.relay.api.error',
    uid: uid('2'),
  }])
  assert.deepEqual(first.value.states, [{
    name: 'ready',
    uid: uid('o'),
  }])
  assert.deepEqual(first.value.tasks, [{
    name: 'agent.relay.api.task',
    task_id: digest('a'),
  }])
  assert.deepEqual(first.value.edges, [{
    from: 'agent.relay.api.input',
    to: 'agent.relay.api.output',
    uid: uid('h'),
  }])
})

test('module review declarations reject duplicate identity before lowering', () => {
  const result = lowerModuleSurface(source([
    `state ready uid ${uid('o')}`,
    `state ready uid ${uid('p')}`,
  ]), manifest)

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'duplicate-module-state')
})

test('module review declarations reject malformed UID and unpinned capability references', () => {
  const invalidUid = lowerModuleSurface(source([
    'error agent.relay.api.error uid short',
  ]), manifest)
  assert.equal(invalidUid.ok, false)
  assert.equal(invalidUid.diagnostics[0].code, 'invalid-module-error')

  const unpinned = lowerModuleSurface(source([
    `capability agent.relay.api.log write log.write uid ${uid('a')}`,
  ]), manifest)
  assert.equal(unpinned.ok, false)
  assert.equal(unpinned.diagnostics[0].code, 'invalid-module-capability')
})

function source(declarations) {
  return [
    're 1.0 compact',
    'module agent.relay.api',
    `import agent.relay.service@${interfaceDigest} as service`,
    `import external std.log@${logDigest} from ${digest('8')} as log`,
    'export serve',
    ...declarations,
    '',
  ].join('\n')
}

function uid(character) {
  return `${character.repeat(25)}e`
}

function digest(character) {
  return `sha256:${character.repeat(64)}`
}
