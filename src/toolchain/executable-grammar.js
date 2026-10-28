import { createSourceDiagnostic } from './source-diagnostic.js'
import { EXECUTABLE_GRAMMAR_PROFILE } from './executable-grammar-profile.js'

const HEADER_PATTERN = new RegExp(
  `^re ([0-9]+\\.[0-9]+) (${EXECUTABLE_GRAMMAR_PROFILE.forms.join('|')})$`,
)
const SUPPORTED_VERSIONS = Object.freeze([EXECUTABLE_GRAMMAR_PROFILE.version])

export function parseExecutableGrammar(source, { file = '<input>' } = {}) {
  const newline = source.indexOf('\n')
  const headerLine = newline === -1 ? source : source.slice(0, newline)
  if (!headerLine.startsWith('re ')) {
    return failure(source, file, {
      actual: headerLine,
      code: 'missing-grammar-header',
      end: headerLine.length,
      expected: EXECUTABLE_GRAMMAR_PROFILE.forms
        .map((form) => EXECUTABLE_GRAMMAR_PROFILE.headers[form])
        .join(' | '),
      repair: {
        action: 'insert',
        expected: EXECUTABLE_GRAMMAR_PROFILE.headers.compact,
      },
      rule: 'header.required',
      start: 0,
    })
  }

  const match = HEADER_PATTERN.exec(headerLine)
  if (match === null) {
    return failure(source, file, {
      actual: headerLine,
      code: 'invalid-grammar-header',
      end: headerLine.length,
      expected: 're <major>.<minor> compact | re <major>.<minor> canonical',
      rule: 'header.shape',
      start: 0,
    })
  }
  if (newline === -1) {
    return failure(source, file, {
      actual: headerLine,
      code: 'invalid-grammar-header',
      end: headerLine.length,
      expected: 'header terminated by LF',
      rule: 'header.line-ending',
      start: 0,
    })
  }

  const version = match[1]
  if (!SUPPORTED_VERSIONS.includes(version)) {
    const versionStart = headerLine.indexOf(version)
    return failure(source, file, {
      actual: version,
      code: 'unsupported-language-version',
      end: versionStart + version.length,
      expected: [...SUPPORTED_VERSIONS],
      rule: 'header.language-version',
      start: versionStart,
      supported: [...SUPPORTED_VERSIONS],
    })
  }

  return {
    ok: true,
    value: {
      bodyOffset: newline + 1,
      kind: match[2],
      version,
    },
  }
}

function failure(source, file, diagnostic) {
  return {
    diagnostics: [createSourceDiagnostic(source, {
      ...diagnostic,
      file,
      phase: 'header',
    })],
    ok: false,
  }
}
