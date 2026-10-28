const SYMBOL_SEGMENT = '[a-z][a-z0-9_]*'
const QUALIFIED_SYMBOL = `${SYMBOL_SEGMENT}(?:\\.${SYMBOL_SEGMENT})*`
const SEMVER_SEGMENT = '(?:0|[1-9][0-9]*)'

const TOKEN_ROLES = Object.freeze([
  ['semantic-symbol', new RegExp(`^${QUALIFIED_SYMBOL}$`)],
  ['capability', new RegExp(`^\\$${SYMBOL_SEGMENT}$`)],
  ['canonical-label', /^%u[a-z2-7]{7}$/],
  ['compact-alias', new RegExp(`^%(?!u)${SYMBOL_SEGMENT}$`)],
  [
    'pinned-reference',
    new RegExp(
      `^${QUALIFIED_SYMBOL}@${SEMVER_SEGMENT}\\.${SEMVER_SEGMENT}\\.${SEMVER_SEGMENT}$`,
    ),
  ],
  ['annotation', new RegExp(`^#\\[${QUALIFIED_SYMBOL}\\]$`)],
])

const RESERVED_WORDS = new Set([
  'branch',
  'call',
  'canonical',
  'cap',
  'compact',
  'fn',
  'let',
  'literal',
  'match',
  're',
  'return',
  'unit',
])

export const S2_FREEZE_PROPOSAL = Object.freeze({
  status: 'candidate',
  kind: 'S2',
  label: '%u + 7 base32',
  moduleSymbol: 'bare symbol',
  capability: '$capability',
  compactAlias: '%compact_alias',
  annotation: '#[...] reserved; rejected in V1',
  annotationStatus: 'reserved-deferred',
  revision: '@revision',
})

export const GRAMMAR_FREEZE_GATES = Object.freeze([
  Object.freeze({
    id: 'G0',
    status: 'pending',
    criterion: 'one grammar source validates parser, serializer snippets, and specification goldens',
  }),
  Object.freeze({
    id: 'G1',
    status: 'pending',
    criterion: 'shared positive and negative corpus passes with no wrong graph or silent reinterpretation',
  }),
  Object.freeze({
    id: 'G2',
    status: 'pending',
    criterion: 'every accepted input has one token stream and parse tree with no dispatcher mismatch',
  }),
  Object.freeze({
    id: 'G3',
    status: 'pending',
    criterion: 'at least 1000000 fuzz and mutation cases have no crash or ambiguity and remain near-linear',
    evidence: 'current S2 Hello + numeric + exact module-surface + production args slices: re.grammar-fuzz-baseline@0.5.0; rerun required after type/loop/par grammar expansion',
  }),
  Object.freeze({
    id: 'G4',
    status: 'pending',
    criterion: 'canonical properties pass and every noncanonical byte sequence is rejected',
  }),
  Object.freeze({
    id: 'G5',
    status: 'pending',
    criterion: 'all specification examples are parser-to-serializer goldens with stable diagnostic code and span',
  }),
  Object.freeze({
    id: 'G6',
    status: 'pending',
    criterion: 'multi-model cold-start tasks pass safety gates before accuracy, repair cost, and token cost comparison',
    evidence: 'fixture-bound task pack and digest-only blind harness exist; real anonymous model runs remain required',
  }),
])

export function classifyS2Token(token) {
  if (typeof token === 'string') {
    const matches = TOKEN_ROLES.filter(
      ([role, pattern]) => pattern.test(token) && !(role === 'semantic-symbol' && RESERVED_WORDS.has(token)),
    )

    if (matches.length === 1) {
      return { ok: true, role: matches[0][0] }
    }
  }

  return {
    ok: false,
    diagnostic: {
      code: 'unrecognized-s2-token',
      token,
    },
  }
}
