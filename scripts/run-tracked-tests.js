#!/usr/bin/env node

import { runTrackedTests } from '../src/toolchain/tracked-test-runner.js'

try {
  const result = runTrackedTests({
    cwd: process.cwd(),
    requested: process.argv.slice(2),
  })
  process.exitCode = result.status === null ? 1 : result.status
} catch (error) {
  const code = typeof error?.code === 'string'
    ? error.code
    : 'tracked test runner failed'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
}
