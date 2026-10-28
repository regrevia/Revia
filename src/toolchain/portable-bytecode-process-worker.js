#!/usr/bin/env node

import {
  executePortableBytecodeProcessRequest,
  parsePortableBytecodeProcessRequestLine,
} from './portable-bytecode-process.js'

const MAX_LINE_BYTES = 1_048_576

let input = ''
let inputBytes = 0
let overflow = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  inputBytes += Buffer.byteLength(chunk, 'utf8')
  if (inputBytes > MAX_LINE_BYTES) {
    overflow = true
    return
  }
  input += chunk
})
process.stdin.on('end', () => {
  const parsed = overflow
    ? rejected('portable-bytecode-process-request-too-large')
    : parsePortableBytecodeProcessRequestLine(input)
  const result = parsed.ok
    ? executePortableBytecodeProcessRequest(parsed.value)
    : parsed
  process.stdout.write(`${canonicalJson(result)}\n`)
})

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
