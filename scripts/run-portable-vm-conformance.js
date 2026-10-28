#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import { checkSource } from '../src/toolchain/demo-toolchain.js'
import {
  runPortableVmConformance,
  verifyPortableVmConformance,
} from '../src/toolchain/portable-vm-conformance.js'

const [abiReport, bundle, corpus, faultCorpus, taskCorpus] = await Promise.all([
  readJson('../release/portable-runtime-abi-report.json'),
  readJson('../test/fixtures/portable-conformance.json'),
  readJson('../test/fixtures/portable-runtime-abi.json'),
  readJson('../test/fixtures/portable-fault-protocol.json'),
  readJson('../test/fixtures/task-runtime-lifecycle.json'),
])
const inputs = {
  abiInputs: { bundle, corpus, faultCorpus, loadGraph, taskCorpus },
  abiReport,
  bundle,
  loadGraph,
}
const report = await runPortableVmConformance(inputs)
if (!report.ok) fail(report.diagnostics[0].code)
const verified = await verifyPortableVmConformance(report.value, inputs)
if (!verified.ok) fail(verified.diagnostics[0].code)

await writeFile(
  new URL('../release/portable-vm-conformance-report.json', import.meta.url),
  `${JSON.stringify(report.value, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${report.value.report_digest}\n`)

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
}

async function loadGraph(entry) {
  const source = await readFile(new URL(`../${entry.graph}`, import.meta.url), 'utf8')
  const checked = checkSource(source, { file: entry.graph })
  if (!checked.ok) fail(checked.diagnostics[0].code)
  return { ...checked.program, graph_revision: entry.graph_revision }
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
