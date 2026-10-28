#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { RELEASE_TOOLCHAIN_PATHS } from '../src/runtime/release-toolchain-inventory.js'
import { digestTrackedFiles } from '../src/runtime/release-evidence.js'
import {
  runAgentAuthoringLoopConformance,
  verifyAgentAuthoringLoopConformance,
} from '../src/toolchain/agent-authoring-loop-conformance.js'

const root = new URL('../', import.meta.url)
const readJson = async (path) => JSON.parse(await readFile(
  new URL(path, root),
  'utf8',
))
const sourcePaths = [
  'src/toolchain/agent-authoring-loop.js',
  'src/toolchain/agent-authoring-loop-conformance.js',
  'src/toolchain/fact-ledger.js',
  'src/toolchain/project-patch.js',
  'src/toolchain/project-review-index.js',
  'src/toolchain/project-translator.js',
]
const sourceAuthority = Object.fromEntries(await Promise.all(
  sourcePaths.map(async (path) => [
    path,
    digestBytes(await readFile(new URL(path, root))),
  ]),
))
const toolchainDigest = digestTrackedFiles(await Promise.all(
  RELEASE_TOOLCHAIN_PATHS.map(async (path) => ({
    bytes: await readFile(new URL(path, root)),
    path,
  })),
))
const inputs = {
  corpus: await readJson('test/fixtures/agent-authoring-loop-corpus.json'),
  project: await readJson('test/fixtures/agent-authoring-loop-project.json'),
  source_authority: sourceAuthority,
  toolchain_digest: toolchainDigest,
}
const report = await runAgentAuthoringLoopConformance(inputs)
const verified = await verifyAgentAuthoringLoopConformance(report, inputs)
if (!verified.ok) throw new TypeError(verified.diagnostics[0].code)

await writeFile(
  new URL('release/agent-authoring-loop-conformance-report.json', root),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${report.report_digest}\n`)

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
