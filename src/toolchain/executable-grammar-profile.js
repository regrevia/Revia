const forms = Object.freeze(['compact', 'canonical'])
const headers = Object.freeze({
  canonical: 're 0.1 canonical',
  compact: 're 0.1 compact',
})

export const EXECUTABLE_GRAMMAR_PROFILE = Object.freeze({
  canonical_schema: 're.canonical@0.1.0',
  descriptor: 're 0.1 compact|canonical',
  forms,
  headers,
  schema: 're.executable-grammar-profile@0.1.0',
  version: '0.1',
})

export function executableGrammarHeader(form) {
  const header = EXECUTABLE_GRAMMAR_PROFILE.headers[form]
  if (header === undefined) {
    throw new TypeError(`unsupported executable grammar form: ${form}`)
  }
  return header
}
