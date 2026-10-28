#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { RELEASE_TOOLCHAIN_PATHS } from '../src/runtime/release-toolchain-inventory.js'
import { digestTrackedFiles } from '../src/runtime/release-evidence.js'
import {
  runHumanSemanticReviewConformance,
  verifyHumanSemanticReviewConformance,
} from '../src/toolchain/human-semantic-review-conformance.js'

const root = new URL('../', import.meta.url)
const readJson = async (path) => JSON.parse(await readFile(
  new URL(path, root),
  'utf8',
))
const sourcePaths = [
  'src/toolchain/fact-ledger.js',
  'src/toolchain/human-semantic-review.js',
  'src/toolchain/human-semantic-review-conformance.js',
  'src/toolchain/project-review-index.js',
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
  corpus: await readJson('test/fixtures/human-semantic-review-corpus.json'),
  project: await readJson('test/fixtures/agent-authoring-loop-project.json'),
  source_authority: sourceAuthority,
  toolchain_digest: toolchainDigest,
}
const report = runHumanSemanticReviewConformance(inputs)
const verified = verifyHumanSemanticReviewConformance(report, inputs)
if (!verified.ok) throw new TypeError(verified.diagnostics[0].code)

await writeFile(
  new URL('release/human-semantic-review-conformance-report.json', root),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${report.report_digest}\n`)

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
