#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import {
  runPortableExecutionHardGate,
  verifyPortableExecutionHardGate,
} from '../src/toolchain/portable-execution-hard-gate.js'

const root = new URL('../', import.meta.url)
const readJson = async (path) => JSON.parse(await readFile(
  new URL(path, root),
  'utf8',
))

const inputs = {
  executionReport: await readJson(
    'release/portable-executor-benchmark-report.json',
  ),
  externalEvidence: await readJson(
    'release/external-runner-matrix-evidence.json',
  ),
  externalMatrix: await readJson('release/external-runner-matrix.json'),
  faultReport: await readJson('release/portable-fault-protocol-report.json'),
  lifecycleReport: await readJson(
    'release/task-runtime-lifecycle-report.json',
  ),
  policy: await readJson('test/fixtures/portable-execution-hard-gate.json'),
  runtimeAbiReport: await readJson('release/portable-runtime-abi-report.json'),
}

const generated = runPortableExecutionHardGate(inputs)
if (!generated.ok) {
  throw new TypeError(generated.diagnostics[0].code)
}
const verified = verifyPortableExecutionHardGate(generated.value, inputs)
if (!verified.ok) {
  throw new TypeError(verified.diagnostics[0].code)
}

await writeFile(
  new URL('release/portable-execution-hard-gate-report.json', root),
  `${JSON.stringify(generated.value, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${generated.value.report_digest}\n`)
