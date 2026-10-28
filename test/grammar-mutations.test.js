import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { parseExecutableGrammar } from '../src/toolchain/executable-grammar.js'
import { parseGrammarCandidate } from '../src/toolchain/grammar-bakeoff.js'

const corpus = await readFixture('grammar-corpus.json')
const mutations = await readFixture('grammar-mutations.json')

test('mutation corpus has stable identities and independently valid seeds', () => {
  assert.equal(mutations.schema, 're.grammar-mutations@0.3.0')
  const identities = mutations.cases.map(({ id }) => id)
  assert.equal(new Set(identities).size, identities.length)

  for (const entry of mutations.cases) {
    const seed = findSeed(entry)
    const parsed = parseGrammarCandidate(seed.input, {
      file: seed.id,
      grammar: seed.grammar,
    })
    assert.equal(parsed.ok, true, entry.id)
  }
})

test('each structural mutation has one anchor and one stable primary failure', () => {
  for (const entry of mutations.cases) {
    const seed = findSeed(entry)
    assert.notEqual(entry.search, entry.replacement, entry.id)
    const offset = seed.input.indexOf(entry.search)
    assert.notEqual(offset, -1, entry.id)
    assert.equal(seed.input.lastIndexOf(entry.search), offset, entry.id)
    const source = seed.input.slice(0, offset) + entry.replacement +
      seed.input.slice(offset + entry.search.length)

    const first = parseGrammarCandidate(source, {
      file: entry.id,
      grammar: seed.grammar,
    })
    const second = parseGrammarCandidate(source, {
      file: entry.id,
      grammar: seed.grammar,
    })
    assert.deepEqual(first, second, entry.id)
    assert.equal(first.ok, false, entry.id)
    assert.deepEqual(project(first.diagnostics[0]), entry.expected, entry.id)
  }
})

test('mutation corpus covers every currently disputed structural boundary', () => {
  assert.deepEqual(
    [...new Set(mutations.cases.map(({ scope }) => scope))].sort(compareAscii),
    [
      'capability-sigil',
      'numeric-format',
      'schema-reference',
      'semantic-sigil',
      'source-form',
      'token-role',
    ],
  )
})

test('settled compact header rejects every one-byte printable substitution', () => {
  const header = 're 0.1 compact\n'
  assert.equal(parseExecutableGrammar(header).ok, true)

  for (let offset = 0; offset < header.length; offset += 1) {
    for (let codePoint = 0x20; codePoint <= 0x7e; codePoint += 1) {
      const replacement = String.fromCodePoint(codePoint)
      if (replacement === header[offset]) continue
      const source = header.slice(0, offset) + replacement +
        header.slice(offset + 1)
      const first = parseExecutableGrammar(source, { file: 'mutated-header.re' })
      const second = parseExecutableGrammar(source, { file: 'mutated-header.re' })
      assert.equal(first.ok, false, `offset=${offset} byte=${codePoint}`)
      assert.deepEqual(first, second, `offset=${offset} byte=${codePoint}`)
    }
  }
})

function findSeed(entry) {
  const seed = corpus.cases.find(({ id }) => id === entry.seed_pair_id)
  assert.notEqual(seed, undefined, entry.id)
  assert.equal(seed.expected.ok, true, entry.id)
  return seed
}

function project({ code, column, line, phase, reason }) {
  return {
    code,
    phase,
    line,
    column,
    ...(reason === undefined ? {} : { reason }),
  }
}

async function readFixture(name) {
  return JSON.parse(await readFile(
    new URL(`./fixtures/${name}`, import.meta.url),
    'utf8',
  ))
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
