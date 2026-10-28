import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { parseGrammarCandidate } from '../src/toolchain/grammar-bakeoff.js'
import { generateDeterministicReplacements } from '../src/toolchain/deterministic-fuzz.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/grammar-corpus.json', import.meta.url),
  'utf8',
))
const seedCase = corpus.cases.find(({ id }) => id === 'PAIR-HELLO-S2')
const printable = Array.from(
  { length: 0x7e - 0x21 + 1 },
  (_, index) => String.fromCodePoint(0x21 + index),
)

test('deterministic replacement generator replays exactly from its seed', () => {
  const options = {
    alphabet: ['a', 'b', 'c'],
    count: 20,
    positions: [0, 1, 2],
    seed: 0x5eed,
  }
  const first = generateDeterministicReplacements('abc', options)
  const second = generateDeterministicReplacements('abc', options)
  assert.deepEqual(first, second)
  assert.equal(first.length, 20)
  assert.ok(first.every(({ source }) => source !== 'abc'))
})

test('ASCII structural fuzz does not pretend to cover Unicode mutation', () => {
  assert.throws(() => generateDeterministicReplacements('é', {
    alphabet: ['a', 'b'],
    count: 1,
    positions: [0],
    seed: 1,
  }), /positions must be ASCII/)
  assert.throws(() => generateDeterministicReplacements('a', {
    alphabet: ['b', '🙂'],
    count: 1,
    positions: [0],
    seed: 1,
  }), /alphabet must be ASCII/)
})

test('ten thousand structural mutations never preserve the same CST', () => {
  const positions = structuralOffsets(seedCase.input)
  const baseline = parseGrammarCandidate(seedCase.input, { grammar: 'S2' })
  const mutations = generateDeterministicReplacements(seedCase.input, {
    alphabet: printable,
    count: 10_000,
    positions,
    seed: 0x52455f31,
  })

  for (const mutation of mutations) {
    const first = parseGrammarCandidate(mutation.source, {
      file: `generated:${mutation.id}`,
      grammar: 'S2',
    })
    const second = parseGrammarCandidate(mutation.source, {
      file: `generated:${mutation.id}`,
      grammar: 'S2',
    })
    assert.deepEqual(first, second, String(mutation.id))
    if (first.ok) {
      assert.notDeepEqual(first.value, baseline.value, String(mutation.id))
    } else {
      assert.equal(typeof first.diagnostics[0].code, 'string', String(mutation.id))
      assert.equal(typeof first.diagnostics[0].phase, 'string', String(mutation.id))
    }
  }
})

function structuralOffsets(source) {
  const headerLength = 're 0.1 compact\n'.length
  const offsets = Array.from({ length: headerLength }, (_, index) => index)
  for (let index = headerLength; index < source.length; index += 1) {
    if ('$%@'.includes(source[index])) offsets.push(index)
  }
  return offsets
}
