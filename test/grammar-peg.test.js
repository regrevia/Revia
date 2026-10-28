import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CANDIDATE_LEXEMES,
  COMPACT_TRIVIA_POLICY,
  CURRENT_LITERAL_CONSTRAINTS,
  isCompactAliasToken,
  PEG_CANDIDATES,
  PEG_SKELETON,
  V1_SOURCE_BOUNDARY_POLICY,
  validatePegCandidate,
} from '../src/toolchain/grammar-peg.js'

test('both PEG candidates are reference-complete for the compact slice', () => {
  assert.deepEqual(validatePegCandidate(PEG_CANDIDATES.S1), {
    ok: true,
    value: {
      candidate: 'S1',
      deferred: [
        'annotation_syntax',
        'canonical_source',
        'cross_module_decl',
      ],
      rules: 33,
    },
  })
  assert.deepEqual(validatePegCandidate(PEG_CANDIDATES.S2), {
    ok: true,
    value: {
      candidate: 'S2',
      deferred: [
        'annotation_syntax',
        'canonical_source',
        'cross_module_decl',
      ],
      rules: 33,
    },
  })
})

test('PEG candidates isolate the disputed sigils and share the graph slice', () => {
  assert.equal(PEG_SKELETON, PEG_CANDIDATES.S2)
  assert.ok(PEG_CANDIDATES.S1.rules.includes(
    'capability_instance <- "@" bare_symbol',
  ))
  assert.ok(PEG_CANDIDATES.S2.rules.includes(
    'capability_instance <- "$" bare_symbol',
  ))
  assert.ok(PEG_CANDIDATES.S1.rules.includes(
    'semantic_symbol <- "@" qualified_symbol',
  ))
  assert.ok(PEG_CANDIDATES.S2.rules.includes(
    'semantic_symbol <- qualified_symbol',
  ))
  assert.deepEqual(
    sharedRules(PEG_CANDIDATES.S1),
    sharedRules(PEG_CANDIDATES.S2),
  )
  assert.equal(PEG_CANDIDATES.S1.lexemes, CANDIDATE_LEXEMES.S1)
  assert.equal(PEG_CANDIDATES.S2.lexemes, CANDIDATE_LEXEMES.S2)
  assert.equal(
    PEG_CANDIDATES.S2.literalConstraints,
    CURRENT_LITERAL_CONSTRAINTS,
  )
  assert.deepEqual(CURRENT_LITERAL_CONSTRAINTS.numericToken, {
    decimal: '-?(0|[1-9][0-9]*) "." [0-9]+',
    digitSeparator: false,
    exponent: false,
    int: '-?(0|[1-9][0-9]*)',
    leadingPlus: false,
    negativeZero: false,
  })
  for (const candidate of Object.values(PEG_CANDIDATES)) {
    assert.equal(candidate.version, '0.5')
    assert.ok(candidate.rules.includes(
      'canonical_label <- "%u" BASE32_7',
    ))
    assert.ok(candidate.rules.includes(
      'compact_alias <- "%" !"u" bare_symbol',
    ))
    assert.equal(candidate.externals.BASE32_7, 'candidate-token-rule')
    assert.equal(candidate.externals.BASE32_12, undefined)
  }
})

test('compact aliases reserve the full %u prefix for canonical labels', () => {
  assert.equal(isCompactAliasToken('%printed'), true)
  assert.equal(isCompactAliasToken('%u'), false)
  assert.equal(isCompactAliasToken('%user'), false)
  assert.equal(isCompactAliasToken('%uabcdefg'), false)
})

test('canonical grammar is declared deferred instead of shadowing compact', () => {
  for (const candidate of Object.values(PEG_CANDIDATES)) {
    assert.deepEqual(candidate.forms.canonical, {
      blockedBy: 'Q-sample-canonical',
      entry: 'canonical_source',
      status: 'deferred',
    })
    assert.equal(candidate.rules.some((rule) =>
      rule.startsWith('canonical_source <-')), false)
  }
})

test('unsettled grammar choices are named seams, not permissive rules', () => {
  assert.deepEqual(PEG_CANDIDATES.S2.deferred, {
    annotation_syntax: 'V1-deferred-annotation',
    canonical_source: 'Q-sample-canonical',
    cross_module_decl: 'Q-module',
  })
  assert.ok(PEG_CANDIDATES.S2.rules.includes(
    'int_literal <- "0" / [1-9] [0-9]* / "-" [1-9] [0-9]*',
  ))
  assert.ok(PEG_CANDIDATES.S2.rules.includes(
    'decimal_literal <- ("0" / [1-9] [0-9]*) "." [0-9]+ / "-" ("0" "." [0-9]* [1-9] [0-9]* / [1-9] [0-9]* "." [0-9]+)',
  ))
})

test('V1 source boundaries reject annotations and make comments non-semantic', () => {
  assert.deepEqual(V1_SOURCE_BOUNDARY_POLICY, {
    annotation: {
      code: 'unsupported-v1-annotation',
      prefix: '#[',
      status: 'reserved-deferred',
    },
    canonical: {
      acceptance: 'load-then-byte-equal-serialize',
      authority: 'serializer',
      comments: 'forbidden',
      freeTrivia: false,
    },
    compactComment: {
      graphEffect: 'none',
      retention: 'discard',
    },
  })
  assert.equal(PEG_CANDIDATES.S1.sourceBoundaryPolicy, V1_SOURCE_BOUNDARY_POLICY)
  assert.equal(PEG_CANDIDATES.S2.sourceBoundaryPolicy, V1_SOURCE_BOUNDARY_POLICY)
  assert.equal(
    PEG_CANDIDATES.S2.rules.some((rule) => rule.startsWith('annotation <-')),
    false,
  )
})

test('compact trivia policy allows only ASCII separators outside comments', () => {
  assert.deepEqual(COMPACT_TRIVIA_POLICY, {
    lineCommentPrefix: '//',
    lineCommentText: 'utf8-with-ascii-whitespace-until-lf',
    whitespaceCodePoints: [0x09, 0x0a, 0x20],
  })
  assert.equal(
    PEG_CANDIDATES.S1.triviaPolicy,
    COMPACT_TRIVIA_POLICY,
  )
  assert.equal(
    PEG_CANDIDATES.S2.triviaPolicy,
    COMPACT_TRIVIA_POLICY,
  )
})

test('PEG validator rejects undefined, duplicate, and unreachable rules', () => {
  const base = PEG_CANDIDATES.S2
  assert.deepEqual(validatePegCandidate({
    ...base,
    rules: base.rules.filter((rule) => !rule.startsWith('int_literal <-')),
  }), {
    diagnostics: [{
      code: 'undefined-peg-rule',
      referenced_by: 'literal_arg',
      rule: 'int_literal',
    }],
    ok: false,
  })

  assert.deepEqual(validatePegCandidate({
    ...base,
    rules: [...base.rules, 'SP <- " "'],
  }), {
    diagnostics: [{ code: 'duplicate-peg-rule', rule: 'SP' }],
    ok: false,
  })

  assert.deepEqual(validatePegCandidate({
    ...base,
    rules: [...base.rules, 'orphan <- "orphan"'],
  }), {
    diagnostics: [{ code: 'unreachable-peg-rules', rules: ['orphan'] }],
    ok: false,
  })
})

test('PEG validator rejects a profile copied with different sigils', () => {
  assert.deepEqual(validatePegCandidate({
    ...PEG_CANDIDATES.S2,
    lexemes: { capabilityPrefix: '@', semanticPrefix: '' },
  }), {
    diagnostics: [{ candidate: 'S2', code: 'peg-candidate-lexeme-drift' }],
    ok: false,
  })
})

test('PEG validator rejects a copied numeric constraint', () => {
  assert.deepEqual(validatePegCandidate({
    ...PEG_CANDIDATES.S2,
    literalConstraints: {
      numericToken: {
        ...CURRENT_LITERAL_CONSTRAINTS.numericToken,
        exponent: true,
      },
    },
  }), {
    diagnostics: [{
      candidate: 'S2',
      code: 'peg-candidate-literal-constraint-drift',
    }],
    ok: false,
  })
})

test('PEG validator rejects a copied compact trivia policy', () => {
  assert.deepEqual(validatePegCandidate({
    ...PEG_CANDIDATES.S2,
    triviaPolicy: {
      ...COMPACT_TRIVIA_POLICY,
      whitespaceCodePoints: [...COMPACT_TRIVIA_POLICY.whitespaceCodePoints, 13],
    },
  }), {
    diagnostics: [{ candidate: 'S2', code: 'peg-candidate-trivia-policy-drift' }],
    ok: false,
  })
})

test('PEG validator rejects a copied V1 source boundary policy', () => {
  assert.deepEqual(validatePegCandidate({
    ...PEG_CANDIDATES.S2,
    sourceBoundaryPolicy: {
      ...V1_SOURCE_BOUNDARY_POLICY,
      annotation: { status: 'candidate' },
    },
  }), {
    diagnostics: [{
      candidate: 'S2',
      code: 'peg-candidate-source-boundary-drift',
    }],
    ok: false,
  })
})

function sharedRules(candidate) {
  return candidate.rules.filter((rule) =>
    !rule.startsWith('semantic_symbol <-') &&
    !rule.startsWith('capability_instance <-') &&
    !rule.startsWith('capability_call <-'))
}
