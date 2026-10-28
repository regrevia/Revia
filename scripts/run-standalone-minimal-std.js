#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

import {
  createMinimalStdNativeBundle,
} from '../src/toolchain/minimal-std-native.js'
import {
  runStandaloneMinimalStdConformance,
} from '../src/toolchain/standalone-minimal-std.js'

const root = new URL('../', import.meta.url)

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('standalone-minimal-std-environment-unsupported')
  }
  const [abi, corpus, archive, policy] = await Promise.all([
    readJson('release/minimal-std-abi-report.json'),
    readJson('test/fixtures/minimal-std-native.json'),
    readJson('release/portable-runtime-package.json'),
    readJson('test/fixtures/portable-runtime-package.json'),
  ])
  const bundle = createMinimalStdNativeBundle({ abi, corpus })
  if (!bundle.ok) fail(bundle.diagnostics[0].code)
  const result = await runStandaloneMinimalStdConformance({
    abi,
    bundle: bundle.value,
    compiler_path: '/usr/bin/clang',
    corpus,
    package_digest: archive.package_digest,
    target_triple: policy.target.target_triple,
  })
  if (!result.ok) fail(result.diagnostics[0].code)
  await writeFile(
    new URL('release/standalone-minimal-std-report.json', root),
    `${JSON.stringify(result.value, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${result.value.report_digest}\n`)
} catch (error) {
  process.stderr.write(
    `${error?.code ?? 'standalone-minimal-std-runner-failed'}\n`,
  )
  process.exitCode = 1
}

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'))
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
