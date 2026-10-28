#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import {
  runPortableVmStdConformance,
  verifyPortableVmStdConformance,
} from '../src/toolchain/portable-vm-std.js'

const core = await readFile(
  new URL('../src/toolchain/portable-vm-core.js', import.meta.url),
)
const coreDigest = `sha256:${createHash('sha256').update(core).digest('hex')}`
const report = runPortableVmStdConformance({ core_digest: coreDigest })
const verified = verifyPortableVmStdConformance(report, {
  core_digest: coreDigest,
})
if (!verified.ok) throw new TypeError(verified.diagnostics[0].code)
await writeFile(
  new URL('../release/portable-vm-std-report.json', import.meta.url),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${report.report_digest}\n`)
