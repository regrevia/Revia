#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  createRealHostAdapterEvidenceReport,
  createRealHostAdapterEvidenceFileAuthority,
  verifyRealHostAdapterEvidenceReport,
} from '../src/toolchain/real-host-adapter-evidence.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const testRun = spawnSync(process.execPath, [
  '--test',
  '--experimental-test-isolation=none',
  'test/server-db-sqlite-connection-set.test.js',
  'test/server-http-client-node-tls-transport.test.js',
  'test/server-secret-deployment.test.js',
], {
  cwd: root,
  encoding: 'utf8',
  shell: false,
})
process.stdout.write(testRun.stdout ?? '')
process.stderr.write(testRun.stderr ?? '')
if (
  testRun.error !== undefined
  || testRun.status !== 0
  || /# SKIP\b/u.test(testRun.stdout ?? '')
) {
  throw new TypeError('real host adapter evidence tests failed')
}
const fileAuthority = await createRealHostAdapterEvidenceFileAuthority({ root })
const report = createRealHostAdapterEvidenceReport({
  environment: {
    architecture: process.arch,
    node_version: process.version,
    platform: process.platform,
  },
  fileAuthority,
  results: {
    'deployment-secret-lifecycle': {
      after_close: 'unavailable',
      close: 'ok',
      repeated_close: 'closed',
      snapshot: 'copied',
    },
    'loopback-tls-bearer-auth': {
      auth_failure: 'http-401',
      deadline_failure: 'deadline_exceeded',
      success: 'trusted-ca-http-200',
      trust_failure: 'unavailable',
      transport: 'tls-loopback',
    },
    'sqlite-cross-process-lock': {
      cleanup: 'child-rollback-close-exit-0',
      fault: 'declared-transient',
      recovery: 'typed-result',
      topology: 'same-host-two-node-processes',
    },
  },
})
const verified = verifyRealHostAdapterEvidenceReport(report, { fileAuthority })
if (!verified.ok) throw new TypeError(verified.diagnostics[0].code)
await writeFile(
  new URL('../release/real-host-adapter-evidence.json', import.meta.url),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${report.report_digest}\n`)
