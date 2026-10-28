import { readFile } from 'node:fs/promises'

import {
  EXTERNAL_RUNNER_TARGETS,
  probeExternalRunner,
  runExternalRunnerRequest,
} from '../src/toolchain/external-runner-matrix.js'

try {
  const [command, targetId, compilerPath, requestPath, packagePath, samplesText] =
    process.argv.slice(2)
  const target = EXTERNAL_RUNNER_TARGETS.find(({ id }) => id === targetId)
  if (target === undefined) fail('external-runner-cli-target-invalid')

  if (command === 'probe') {
    const result = await probeExternalRunner({
      compiler_path: compilerPath,
      target,
    })
    emit(result)
  } else if (command === 'run') {
    if (requestPath === undefined || packagePath === undefined) {
      fail('external-runner-cli-arguments-invalid')
    }
    const result = await runExternalRunnerRequest({
      compiler_path: compilerPath,
      package: await readJson(packagePath),
      request: await readJson(requestPath),
      samples: samplesText === undefined ? 2 : Number(samplesText),
    })
    emit(result)
  } else {
    fail('external-runner-cli-command-invalid')
  }
} catch (error) {
  process.stderr.write(`${error?.code ?? 'external-runner-cli-failed'}\n`)
  process.exitCode = 1
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function emit(result) {
  if (!result?.ok) {
    fail(result?.diagnostics?.[0]?.code ?? 'external-runner-cli-failed')
  }
  process.stdout.write(`${JSON.stringify(result.value)}\n`)
}

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}
