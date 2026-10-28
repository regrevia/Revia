import { V1_NUMERIC_TOKEN_CONTRACT } from './numeric-literal.js'

const SHARED_RULES = Object.freeze([
  'source <- compact_source',
  'compact_source <- compact_header compact_body EOF',
  'compact_header <- "re" SP "0.1" SP "compact" LF',
  'compact_body <- unit_decl capability_decl* function_decl',
  'unit_decl <- "unit" semantic_symbol',
  'capability_decl <- "cap" capability_instance ":" schema_reference',
  'function_decl <- "fn" semantic_symbol "(" ")" "->" qualified_symbol block',
  'block <- "{" statement* "}"',
  'statement <- let_stmt / return_stmt',
  'let_stmt <- compact_alias "=" call_expr',
  'return_stmt <- "return" match_expr',
  'match_expr <- "match" compact_alias "{" branch+ "}"',
  'branch <- qualified_symbol "(" "_" ")" "=>" call_expr',
  'call_expr <- operation_call "(" call_arg ")"',
  'operation_call <- capability_call / qualified_symbol',
  'call_arg <- named_arg / literal_arg',
  'named_arg <- bare_symbol ":" literal_arg',
  'literal_arg <- string_literal / decimal_literal / int_literal',
  'qualified_symbol <- bare_symbol ("." bare_symbol)*',
  'bare_symbol <- [a-z] [a-z0-9_]*',
  'schema_reference <- qualified_symbol "@" semver',
  'semver <- semver_part "." semver_part "." semver_part',
  'semver_part <- "0" / [1-9] [0-9]*',
  'int_literal <- "0" / [1-9] [0-9]* / "-" [1-9] [0-9]*',
  'decimal_literal <- ("0" / [1-9] [0-9]*) "." [0-9]+ / "-" ("0" "." [0-9]* [1-9] [0-9]* / [1-9] [0-9]* "." [0-9]+)',
  'string_literal <- JSON_STRING',
  'canonical_label <- "%u" BASE32_7',
  'SP <- " "',
  'LF <- "\\n"',
])

export const CANDIDATE_LEXEMES = Object.freeze({
  S1: Object.freeze({ capabilityPrefix: '@', semanticPrefix: '@' }),
  S2: Object.freeze({ capabilityPrefix: '$', semanticPrefix: '' }),
})

export const COMPACT_TRIVIA_POLICY = Object.freeze({
  lineCommentPrefix: '//',
  lineCommentText: 'utf8-with-ascii-whitespace-until-lf',
  whitespaceCodePoints: Object.freeze([0x09, 0x0a, 0x20]),
})

export const V1_SOURCE_BOUNDARY_POLICY = Object.freeze({
  annotation: Object.freeze({
    code: 'unsupported-v1-annotation',
    prefix: '#[',
    status: 'reserved-deferred',
  }),
  canonical: Object.freeze({
    acceptance: 'load-then-byte-equal-serialize',
    authority: 'serializer',
    comments: 'forbidden',
    freeTrivia: false,
  }),
  compactComment: Object.freeze({
    graphEffect: 'none',
    retention: 'discard',
  }),
})

export const CURRENT_LITERAL_CONSTRAINTS = Object.freeze({
  numericToken: V1_NUMERIC_TOKEN_CONTRACT,
})

const EXTERNALS = Object.freeze({
  BASE32_7: 'candidate-token-rule',
  EOF: 'lexer-boundary',
  JSON_STRING: 'json-string-lexer',
})

const DEFERRED_RULES = Object.freeze({
  annotation_syntax: 'V1-deferred-annotation',
  canonical_source: 'Q-sample-canonical',
  cross_module_decl: 'Q-module',
})

export const PEG_CANDIDATES = Object.freeze({
  S1: buildPegCandidate('S1'),
  S2: buildPegCandidate('S2'),
})

// Compatibility name for the current leading candidate. It remains a
// candidate manifest and is not a production parser or a frozen grammar.
export const PEG_SKELETON = PEG_CANDIDATES.S2

export function isCompactAliasToken(token) {
  return typeof token === 'string' && /^%(?!u)[a-z][a-z0-9_]*$/.test(token)
}

export function validatePegCandidate(candidate) {
  if (candidate === null || typeof candidate !== 'object') {
    return failure({ code: 'invalid-peg-candidate' })
  }
  if (!['S1', 'S2'].includes(candidate.candidate)) {
    return failure({
      actual: candidate.candidate,
      code: 'invalid-peg-candidate-name',
      expected: ['S1', 'S2'],
    })
  }
  if (!sameLexemes(candidate.lexemes, CANDIDATE_LEXEMES[candidate.candidate])) {
    return failure({
      candidate: candidate.candidate,
      code: 'peg-candidate-lexeme-drift',
    })
  }
  if (candidate.literalConstraints !== CURRENT_LITERAL_CONSTRAINTS) {
    return failure({
      candidate: candidate.candidate,
      code: 'peg-candidate-literal-constraint-drift',
    })
  }
  if (candidate.triviaPolicy !== COMPACT_TRIVIA_POLICY) {
    return failure({
      candidate: candidate.candidate,
      code: 'peg-candidate-trivia-policy-drift',
    })
  }
  if (candidate.sourceBoundaryPolicy !== V1_SOURCE_BOUNDARY_POLICY) {
    return failure({
      candidate: candidate.candidate,
      code: 'peg-candidate-source-boundary-drift',
    })
  }
  if (!Array.isArray(candidate.rules)) {
    return failure({ code: 'invalid-peg-rule-list' })
  }

  const definitions = new Map()
  for (const rule of candidate.rules) {
    const parsed = parseRule(rule)
    if (!parsed.ok) return parsed
    if (definitions.has(parsed.value.name)) {
      return failure({
        code: 'duplicate-peg-rule',
        rule: parsed.value.name,
      })
    }
    definitions.set(parsed.value.name, parsed.value.expression)
  }

  if (!definitions.has(candidate.entry)) {
    return failure({ code: 'missing-peg-entry', entry: candidate.entry })
  }

  const externals = new Set(Object.keys(candidate.externals ?? {}))
  const deferred = new Set(Object.keys(candidate.deferred ?? {}))
  for (const [name, expression] of definitions) {
    for (const reference of ruleReferences(expression)) {
      if (
        !definitions.has(reference) &&
        !externals.has(reference) &&
        !deferred.has(reference)
      ) {
        return failure({
          code: 'undefined-peg-rule',
          referenced_by: name,
          rule: reference,
        })
      }
    }
  }

  for (const [form, contract] of Object.entries(candidate.forms ?? {})) {
    const isDefined = definitions.has(contract.entry)
    const isDeferred = deferred.has(contract.entry)
    if (contract.status === 'candidate' && !isDefined) {
      return failure({
        code: 'missing-peg-form-entry',
        form,
        rule: contract.entry,
      })
    }
    if (contract.status === 'deferred' && !isDeferred) {
      return failure({
        code: 'undeclared-deferred-peg-form',
        form,
        rule: contract.entry,
      })
    }
  }

  const roots = [candidate.entry, ...(candidate.exports ?? [])]
  const reachable = reachableRules(roots, definitions)
  const unreachable = [...definitions.keys()]
    .filter((name) => !reachable.has(name))
    .sort(compareAscii)
  if (unreachable.length > 0) {
    return failure({ code: 'unreachable-peg-rules', rules: unreachable })
  }

  return {
    ok: true,
    value: {
      candidate: candidate.candidate,
      deferred: [...deferred].sort(compareAscii),
      rules: definitions.size,
    },
  }
}

function buildPegCandidate(candidate) {
  const lexemes = CANDIDATE_LEXEMES[candidate]
  return Object.freeze({
    candidate,
    deferred: DEFERRED_RULES,
    entry: 'source',
    exports: Object.freeze(['canonical_label']),
    externals: EXTERNALS,
    forms: Object.freeze({
      canonical: Object.freeze({
        blockedBy: DEFERRED_RULES.canonical_source,
        entry: 'canonical_source',
        status: 'deferred',
      }),
      compact: Object.freeze({ entry: 'compact_source', status: 'candidate' }),
    }),
    lexemes,
    literalConstraints: CURRENT_LITERAL_CONSTRAINTS,
    rules: Object.freeze([...SHARED_RULES, ...profileRules(lexemes)]),
    sourceBoundaryPolicy: V1_SOURCE_BOUNDARY_POLICY,
    triviaPolicy: COMPACT_TRIVIA_POLICY,
    version: '0.5',
  })
}

function profileRules({ capabilityPrefix, semanticPrefix }) {
  const semantic = semanticPrefix === ''
    ? 'qualified_symbol'
    : `"${semanticPrefix}" qualified_symbol`
  return [
    `semantic_symbol <- ${semantic}`,
    `capability_instance <- "${capabilityPrefix}" bare_symbol`,
    `capability_call <- "${capabilityPrefix}" bare_symbol "." bare_symbol`,
    'compact_alias <- "%" !"u" bare_symbol',
  ]
}

function sameLexemes(actual, expected) {
  return actual?.capabilityPrefix === expected.capabilityPrefix &&
    actual?.semanticPrefix === expected.semanticPrefix
}

function parseRule(rule) {
  if (typeof rule !== 'string') {
    return failure({ code: 'invalid-peg-rule', rule })
  }
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*<-\s*(.+)$/.exec(rule)
  if (match === null) {
    return failure({ code: 'invalid-peg-rule', rule })
  }
  return { ok: true, value: { expression: match[2], name: match[1] } }
}

function ruleReferences(expression) {
  const withoutTerminals = expression
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/\[(?:\\.|[^\]\\])*\]/g, ' ')
  return withoutTerminals.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
}

function reachableRules(roots, definitions) {
  const reachable = new Set()
  const pending = [...roots]
  while (pending.length > 0) {
    const name = pending.pop()
    if (reachable.has(name) || !definitions.has(name)) continue
    reachable.add(name)
    for (const reference of ruleReferences(definitions.get(name))) {
      pending.push(reference)
    }
  }
  return reachable
}

function failure(diagnostic) {
  return { diagnostics: [diagnostic], ok: false }
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
