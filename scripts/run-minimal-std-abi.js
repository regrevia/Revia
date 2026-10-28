#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import {
  createMinimalStdAbiReport,
  verifyMinimalStdAbiReport,
} from '../src/toolchain/minimal-std-abi.js'

try {
  const corpus = JSON.parse(await readFile(
    new URL('../test/fixtures/minimal-std-abi.json', import.meta.url),
    'utf8',
  ))
  const created = createMinimalStdAbiReport(corpus)
  if (!created.ok) fail(created.diagnostics[0].code)
  const verified = verifyMinimalStdAbiReport(created.value, corpus)
  if (!verified.ok) fail(verified.diagnostics[0].code)

  await writeFile(
    new URL('../release/minimal-std-abi-report.json', import.meta.url),
    `${JSON.stringify(created.value, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${JSON.stringify({
    modules: created.value.modules.map(({ module, operations }) => ({
      module,
      operations: operations.length,
    })),
    package_digest: created.value.package_digest,
    report_digest: created.value.report_digest,
    schema: created.value.schema,
  })}\n`)
} catch (error) {
  process.stderr.write(`${error?.code ?? 'minimal-std-abi-runner-failed'}\n`)
  process.exitCode = 1
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
