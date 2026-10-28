import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GRAMMAR_FREEZE_GATES,
  S2_FREEZE_PROPOSAL,
  classifyS2Token,
} from '../src/toolchain/grammar-freeze.js'

test('S2 classifies each reserved role-shaped token without claiming source acceptance', () => {
  const corpus = [
    ['vision.resize', 'semantic-symbol'],
    ['$stdout', 'capability'],
    ['%printed', 'compact-alias'],
    ['%uabcdefg', 'canonical-label'],
    ['process.stdout@0.1.0', 'pinned-reference'],
    ['#[audit.trace]', 'annotation'],
  ]

  for (const [token, role] of corpus) {
    assert.deepEqual(classifyS2Token(token), { ok: true, role })
  }

  assert.equal(S2_FREEZE_PROPOSAL.annotationStatus, 'reserved-deferred')
  assert.equal(
    S2_FREEZE_PROPOSAL.annotation,
    '#[...] reserved; rejected in V1',
  )
  assert.equal(S2_FREEZE_PROPOSAL.label, '%u + 7 base32')
})

test('G3 records current-slice evidence without claiming full grammar freeze', () => {
  const gate = GRAMMAR_FREEZE_GATES.find(({ id }) => id === 'G3')

  assert.equal(gate.status, 'pending')
  assert.match(gate.evidence, /Hello \+ numeric \+ exact module-surface \+ production args/)
  assert.match(gate.evidence, /re\.grammar-fuzz-baseline@0\.5\.0/)
  assert.match(gate.evidence, /type\/loop\/par grammar expansion/)
})

test('G6 records harness evidence without claiming model cold-start success', () => {
  const gate = GRAMMAR_FREEZE_GATES.find(({ id }) => id === 'G6')

  assert.equal(gate.status, 'pending')
  assert.match(gate.evidence, /digest-only blind harness/)
  assert.match(gate.evidence, /real anonymous model runs remain required/)
})

test('S2 rejects legacy, malformed, and role-crossing tokens without guessing', () => {
  const corpus = [
    '@main',
    '#uabcdefghijkl',
    '%uabcdef',
    '%uabcdefgh',
    '$vision.resize',
    '%value.member',
    'process.stdout@01.2.3',
    'fn',
  ]

  for (const token of corpus) {
    assert.deepEqual(classifyS2Token(token), {
      ok: false,
      diagnostic: {
        code: 'unrecognized-s2-token',
        token,
      },
    })
  }
})
