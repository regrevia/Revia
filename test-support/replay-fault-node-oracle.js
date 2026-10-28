#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { checkSource, runSource } from '../src/toolchain/demo-toolchain.js'
import { graphRevision } from '../src/toolchain/structured-patch.js'

const [sourcePath, inputDigest, transcriptPath] = process.argv.slice(2)
if (sourcePath === undefined || inputDigest === undefined || transcriptPath === undefined) {
  process.stderr.write('usage: replay-fault-node-oracle <source> <input-digest> <transcript>\n')
  process.exit(64)
}

const source = await readFile(sourcePath, 'utf8')
const transcript = await readFile(transcriptPath, 'utf8')
const canonicalTranscript = canonicalJson(JSON.parse(transcript))
if (`${canonicalTranscript}\n` !== transcript) {
  process.stderr.write('node-replay-fault-oracle-transcript-non-canonical\n')
  process.exit(65)
}

const result = runSource(source, {
  file: sourcePath,
  fileSandboxRoot: dirname(resolve(sourcePath)),
})
const checked = checkSource(source, { file: sourcePath })
const outcome = result.outcome
let kind
let code
let graph_revision = null
if (outcome.kind === 'check-failure') {
  kind = 'check-failure'
  code = outcome.diagnostics[0]?.code
} else if (outcome.kind === 'host-fault') {
  kind = 'host-fault'
  code = outcome.fault?.code
  graph_revision = checked.ok ? graphRevision(checked.program) : null
} else {
  process.stderr.write('node-replay-fault-oracle-success\n')
  process.exit(65)
}
if (typeof code !== 'string' || code.length === 0) {
  process.stderr.write('node-replay-fault-oracle-code-missing\n')
  process.exit(65)
}

const fault = {
  backend: 'node',
  code,
  graph_revision,
  input_digest: inputDigest,
  kind,
  schema: 're.native-replay-fault-result@0.1.0',
  semantic_digest: digest({
    code,
    kind,
  }),
  status: 'measured',
  toolchain_digest: digest(`re.node-reference-toolchain@0.1.0\n${process.versions.node}`),
  transcript_digest: digest(`${canonicalTranscript}\n`),
}
fault.result_digest = digest(fault)
process.stdout.write(`${canonicalJson(fault)}\n`)

function digest(value) {
  const bytes = typeof value === 'string' ? value : canonicalJson(value)
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}
