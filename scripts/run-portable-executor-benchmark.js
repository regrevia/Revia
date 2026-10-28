#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import { checkSource } from '../src/toolchain/demo-toolchain.js'
import {
  runPortableExecutorBenchmark,
  verifyPortableExecutorBenchmark,
} from '../src/toolchain/portable-executor-equivalence.js'

const root = new URL('../', import.meta.url)
const bundle = JSON.parse(await readFile(
  new URL('../test/fixtures/portable-conformance.json', import.meta.url),
  'utf8',
))
const report = await runPortableExecutorBenchmark(bundle, {
  loadGraph: async (entry) => {
    const source = await readFile(new URL(entry.graph, root), 'utf8')
    const checked = checkSource(source, { file: entry.graph })
    if (!checked.ok) {
      throw Object.assign(
        new TypeError(checked.diagnostics[0].code),
        { code: checked.diagnostics[0].code },
      )
    }
    return { ...checked.program, graph_revision: entry.graph_revision }
  },
})
if (!report.ok) {
  throw Object.assign(
    new TypeError(report.diagnostics[0].code),
    { code: report.diagnostics[0].code },
  )
}
const verified = await verifyPortableExecutorBenchmark(
  report.value,
  bundle,
  {
    loadGraph: async (entry) => {
      const source = await readFile(new URL(entry.graph, root), 'utf8')
      const checked = checkSource(source, { file: entry.graph })
      if (!checked.ok) {
        throw Object.assign(
          new TypeError(checked.diagnostics[0].code),
          { code: checked.diagnostics[0].code },
        )
      }
      return { ...checked.program, graph_revision: entry.graph_revision }
    },
  },
)
if (!verified.ok) {
  throw Object.assign(
    new TypeError(verified.diagnostics[0].code),
    { code: verified.diagnostics[0].code },
  )
}
await writeFile(
  new URL('../release/portable-executor-benchmark-report.json', import.meta.url),
  `${JSON.stringify(report.value, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${report.value.report_digest}\n`)
