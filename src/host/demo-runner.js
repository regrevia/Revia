import { serializeRunResult } from './json-output.js'
import { decodeCanonicalInteger } from '../toolchain/integer-literal.js'

export function processExit(code) {
  const decoded = decodeProcessExitCode(code)
  if (!decoded.ok) throw new TypeError('invalid process exit code')
  return { code: decoded.value, type: 'process.status' }
}

export function checkProcessExitLiteral(code, location) {
  if (decodeProcessExitCode(code).ok) {
    return { ok: true }
  }
  return {
    diagnostics: [
      {
        actual: code,
        code: 'process-exit-code-out-of-range',
        ...location,
        expected: '0..255',
        type: 'process.exit_code',
      },
    ],
    ok: false,
  }
}

function decodeProcessExitCode(code) {
  if (Number.isSafeInteger(code) && code >= 0 && code <= 255) {
    return { ok: true, value: code }
  }
  const decoded = decodeCanonicalInteger(code)
  if (!decoded.ok || decoded.value < 0n || decoded.value > 255n) {
    return { ok: false }
  }
  return { ok: true, value: Number(decoded.value) }
}

export function runProgram({ check, execute, readProgramStdout = () => '' }) {
  const checked = check()
  if (!checked.ok) {
    return {
      outcome: { diagnostics: checked.diagnostics, kind: 'check-failure' },
      programStdout: '',
    }
  }
  const status = execute()
  if (status.kind === 'host-fault') {
    return {
      outcome: status,
      programStdout: readProgramStdout(),
    }
  }
  return {
    outcome: { kind: 'process-status', status: { code: status.code } },
    programStdout: readProgramStdout(),
  }
}

export function runProgramAsJson(options) {
  const result = runProgram(options)
  return serializeRunResult({
    outcome: result.outcome,
    programStdout: result.programStdout,
  })
}
