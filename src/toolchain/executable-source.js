import { loadCanonicalGraphBody } from './canonical.js'
import { parseExecutableGrammar } from './executable-grammar.js'
import { parseCompactProgramBody } from './parser.js'

export function parseExecutableSource(source, { file = '<input>' } = {}) {
  const grammar = parseExecutableGrammar(source, { file })
  if (!grammar.ok) return grammar

  const body = source.slice(grammar.value.bodyOffset)
  if (grammar.value.kind === 'compact') {
    const parsed = parseCompactProgramBody(body, {
      file,
      fullSource: source,
      lineOffset: 1,
      sourceOffset: grammar.value.bodyOffset,
      version: grammar.value.version,
    })
    return parsed.ok ? { ...parsed, form: 'compact' } : parsed
  }

  const loaded = contextualizeCanonical(
    loadCanonicalGraphBody(body, { canonicalSource: source }),
    file,
  )
  return loaded.ok ? { ...loaded, form: 'canonical' } : loaded
}

function contextualizeCanonical(loaded, file) {
  if (!loaded.ok) {
    return {
      ...loaded,
      diagnostics: loaded.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        file,
      })),
    }
  }
  rewriteCanonicalLocations(loaded.value, file)
  return loaded
}

function rewriteCanonicalLocations(value, file) {
  if (Array.isArray(value)) {
    for (const child of value) rewriteCanonicalLocations(child, file)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (value.location?.file === '<canonical>') {
    value.location = { ...value.location, file }
  }
  for (const child of Object.values(value)) {
    rewriteCanonicalLocations(child, file)
  }
}
