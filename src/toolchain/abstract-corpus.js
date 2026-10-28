const GRAMMAR_CANDIDATES = Object.freeze(['S1', 'S2'])
const SOURCE_FORMS = Object.freeze(['compact', 'canonical'])

export function buildAbstractCorpusSchema() {
  return {
    accepted_fields: [
      'body',
      'blocked_by',
      'expected_cst',
      'expected_diagnostics',
      'expected_graph',
      'expected_tokens',
      'grammar',
      'id',
      'input',
      'notes',
      'pair_id',
      'source_form',
      'source_shape',
      'subject',
    ],
    corpus_kind: 'shared-abstract-corpus',
    grammar_candidates: [...GRAMMAR_CANDIDATES],
    source_forms: [...SOURCE_FORMS],
    version: '0.4',
  }
}

export function validateAbstractCorpusEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { diagnostics: [{ code: 'invalid-abstract-corpus-entry' }], ok: false }
  }
  for (const field of [
    'id',
    'grammar',
    'body',
    'source_form',
    'source_shape',
    'pair_id',
    'input',
  ]) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      return { diagnostics: [{ code: 'missing-abstract-corpus-field', field }], ok: false }
    }
  }
  if (!GRAMMAR_CANDIDATES.includes(entry.grammar)) {
    return {
      diagnostics: [{ actual: entry.grammar, code: 'invalid-abstract-corpus-grammar' }],
      ok: false,
    }
  }
  if (!SOURCE_FORMS.includes(entry.source_form)) {
    return {
      diagnostics: [{ actual: entry.source_form, code: 'invalid-abstract-corpus-source-form' }],
      ok: false,
    }
  }
  return { ok: true, value: entry }
}

export function validateAbstractCorpusPairs(entries) {
  if (!Array.isArray(entries)) {
    return failure({ code: 'invalid-abstract-corpus-pairs' })
  }
  if (entries.length === 0) {
    return failure({ code: 'empty-abstract-corpus-pairs' })
  }

  for (const entry of entries) {
    const result = validateAbstractCorpusEntry(entry)
    if (!result.ok) {
      return failure({
        ...result.diagnostics[0],
        entry_id: typeof entry?.id === 'string' ? entry.id : null,
      })
    }
  }

  const pairs = new Map()
  for (const entry of entries) {
    const variants = pairs.get(entry.pair_id) ?? []
    variants.push(entry)
    pairs.set(entry.pair_id, variants)
  }

  for (const pairId of [...pairs.keys()].sort(compareAscii)) {
    const variants = pairs.get(pairId)
    const grammars = variants.map(({ grammar }) => grammar).sort(compareAscii)
    if (variants.length !== 2 || grammars[0] !== 'S1' || grammars[1] !== 'S2') {
      return failure({
        actual: grammars,
        code: 'incomplete-abstract-corpus-pair',
        expected: ['S1', 'S2'],
        pair_id: pairId,
      })
    }

    for (const field of [
      'body',
      'blocked_by',
      'source_form',
      'source_shape',
      'subject',
    ]) {
      if (variants[0][field] !== variants[1][field]) {
        return failure({
          code: 'abstract-corpus-pair-mismatch',
          field,
          pair_id: pairId,
        })
      }
    }
  }

  return { ok: true, value: { entries: entries.length, pairs: pairs.size } }
}

function failure(diagnostic) {
  return { diagnostics: [diagnostic], ok: false }
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
