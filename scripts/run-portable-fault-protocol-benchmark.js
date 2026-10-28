#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import { checkSource } from '../src/toolchain/demo-toolchain.js'
import {
  runPortableFaultProtocolBenchmark,
  verifyPortableFaultProtocolBenchmark,
} from '../src/toolchain/portable-fault-protocol.js'

const corpus = JSON.parse(await readFile(
  new URL('../test/fixtures/portable-fault-protocol.json', import.meta.url),
  'utf8',
))
const source = await readFile(
  new URL('../test/golden/canonical-hello.re', import.meta.url),
  'utf8',
)
const checked = checkSource(source, {
  file: 'test/golden/canonical-hello.re',
})
if (!checked.ok) fail(checked.diagnostics[0].code)
const graph = {
  ...checked.program,
  graph_revision:
    'sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083',
}
const report = await runPortableFaultProtocolBenchmark(corpus, { graph })
if (!report.ok) fail(report.diagnostics[0].code)
const verified = await verifyPortableFaultProtocolBenchmark(
  report.value,
  corpus,
  { graph },
)
if (!verified.ok) fail(verified.diagnostics[0].code)

await writeFile(
  new URL('../release/portable-fault-protocol-report.json', import.meta.url),
  `${JSON.stringify(report.value, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${report.value.report_digest}\n`)

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
