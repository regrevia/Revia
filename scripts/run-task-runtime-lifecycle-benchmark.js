#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import {
  runTaskRuntimeLifecycleBenchmark,
  verifyTaskRuntimeLifecycleBenchmark,
} from '../src/toolchain/task-runtime-lifecycle.js'

const corpus = JSON.parse(await readFile(
  new URL('../test/fixtures/task-runtime-lifecycle.json', import.meta.url),
  'utf8',
))
const report = await runTaskRuntimeLifecycleBenchmark(corpus)
if (!report.ok) fail(report.diagnostics[0].code)
const verified = await verifyTaskRuntimeLifecycleBenchmark(report.value, corpus)
if (!verified.ok) fail(verified.diagnostics[0].code)

await writeFile(
  new URL('../release/task-runtime-lifecycle-report.json', import.meta.url),
  `${JSON.stringify(report.value, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${report.value.report_digest}\n`)

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
