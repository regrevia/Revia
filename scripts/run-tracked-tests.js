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
  const message = error instanceof Error && error.message
    ? error.message
    : code
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
