#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import {
  serializeBuildResult,
  serializeCheckResult,
  serializeAuditResult,
  serializeManifestResult,
  serializeModuleSurfaceResult,
  serializePatchResult,
  serializeProfileResult,
  serializeProjectCheckResult,
  serializeInterfaceProjectionResult,
  serializeProjectRunResult,
  serializeProjectTranslationResult,
  serializeReviewFactResult,
  serializeReviewIndexResult,
  serializeRunResult,
  serializeTranslationResult,
} from '../host/json-output.js'
import { serializeCanonicalGraph } from '../toolchain/canonical.js'
import {
  buildSource,
  checkSource,
  auditSource,
  patchSource,
  profileSource,
  reviewFactSource,
  reviewIndexSource,
  reviewSource,
  runSource,
  translateSource,
  viewSource,
} from '../toolchain/demo-toolchain.js'
import { packageManifestDigest } from '../toolchain/module-contract.js'
import { lowerModuleSurface } from '../toolchain/module-surface.js'
import { loadProjectDirectory } from '../toolchain/project-loader.js'
import { translateProject } from '../toolchain/project-translator.js'
import { executeProjectRun } from '../toolchain/project-runner.js'
import {
  validateInterfaceProjectionRoutes,
  writeInterfaceProjection,
} from '../toolchain/interface-projection.js'
import { decodeUtf8Source } from '../toolchain/source-text.js'

const EXIT_USAGE = 64
const EXIT_CHECK_FAILURE = 65
const EXIT_HOST_FAULT = 70

await main(process.argv.slice(2))

async function main(arguments_) {
  const parsed = parseArguments(arguments_)
  if (!parsed.ok) {
    process.stderr.write(
      'Usage: re check [--format json | --write] <file.re>\n       re audit --format json <file.re>\n       re build --out <dir> <file.re>\n       re manifest <file.re>\n       re patch --patch <patch.json> <file.re>\n       re profile <file.re>\n       re project-check --format json <project-dir>\n       re project-run --fixture <fixture.json> <project-dir>\n       re project-projection --routes <routes.json> --out <dir> <project-dir>\n       re module-surface --manifest <manifest.json> <file.re>\n       re review-index [--changed-since <revision>] [--cursor <cursor>] [--limit <n>] [--fact-id <id> --index-revision <revision>] <file.re>\n       re run [--format json] <file.re> [-- <args>...]\n       re translate --format json <file.re>\n       re view [--locale zh-CN|en-US] [--format html|svg] <file.re>\n',
    )
    process.exitCode = EXIT_USAGE
    return
  }
  const {
    command,
    changedSince,
    cursor,
    factId,
    file,
    fixtureFile,
    format,
    indexRevision,
    locale,
    limit,
    manifestFile,
    outDir,
    patchFile,
    programArguments,
    routesFile,
    write,
  } = parsed

  if (command === 'project-check') {
    const result = await loadProjectDirectory(file)
    process.stdout.write(serializeProjectCheckResult({ result }))
    process.exitCode = result.ok ? 0 : EXIT_CHECK_FAILURE
    return
  }

  if (command === 'project-translate') {
    const loaded = await loadProjectDirectory(file)
    const result = loaded.ok
      ? translateProject(loaded.value, { locale, media: format === 'json' ? 'all' : format })
      : loaded
    process.stdout.write(serializeProjectTranslationResult({ file, format, result }))
    process.exitCode = result.ok ? 0 : EXIT_CHECK_FAILURE
    return
  }

  if (command === 'project-run') {
    const loaded = await loadProjectDirectory(file)
    const result = loaded.ok
      ? await executeProjectRun(loaded.value, fixtureFile)
      : loaded
    process.stdout.write(serializeProjectRunResult({
      fixture: fixtureFile,
      result,
    }))
    process.exitCode = result.ok ? 0 : EXIT_CHECK_FAILURE
    return
  }

  if (command === 'project-projection') {
    const loaded = await loadProjectDirectory(file)
    let result = loaded
    if (loaded.ok) {
      try {
        const routesInput = JSON.parse(await readFile(routesFile, 'utf8'))
        const routes = validateInterfaceProjectionRoutes(routesInput)
        result = routes.ok
          ? await writeInterfaceProjection(loaded.value, {
            graph_revision: routes.value.graph_revision,
            output: outDir,
            routes: routes.value.routes,
          })
          : routes
      } catch (error) {
        result = {
          diagnostics: [{
            code: error.code === 'ENOENT'
              ? 'projection-routes-file-missing'
              : 'projection-routes-file-invalid',
          }],
          ok: false,
        }
      }
    }
    process.stdout.write(serializeInterfaceProjectionResult({ result }))
    process.exitCode = result.ok ? 0 : EXIT_CHECK_FAILURE
    return
  }

  let sourceBytes
  try {
    sourceBytes = await readFile(file)
  } catch (error) {
    if (command === 'run' && format === 'json') {
      process.stdout.write(
        serializeRunResult({
          outcome: {
            diagnostics: [{
              code: 'input-file-unreadable',
              column: 1,
              file,
              line: 1,
              reason: error.code ?? 'unknown-error',
            }],
            kind: 'check-failure',
          },
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    if (command === 'translate') {
      process.stdout.write(
        serializeTranslationResult({
          file,
          result: {
            diagnostics: [{
              code: 'input-file-unreadable',
              column: 1,
              file,
              line: 1,
              reason: error.code ?? 'unknown-error',
            }],
            ok: false,
          },
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    if (command === 'module-surface') {
      process.stdout.write(
        serializeModuleSurfaceResult({
          file,
          manifestFile,
          result: {
            diagnostics: [{
              code: 'input-file-unreadable',
              column: 1,
              file,
              line: 1,
              reason: error.code ?? 'unknown-error',
            }],
            ok: false,
          },
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    if (command === 'build') {
      process.stdout.write(
        serializeBuildResult({
          outDir,
          result: {
            diagnostics: [{
              code: 'input-file-unreadable',
              column: 1,
              file,
              line: 1,
              reason: error.code ?? 'unknown-error',
            }],
            ok: false,
          },
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    if (command === 'review-index' && (factId !== null || indexRevision !== null)) {
      process.stdout.write(
        serializeReviewFactResult({
          file,
          result: {
            diagnostics: [{
              code: 'input-file-unreadable',
              column: 1,
              file,
              line: 1,
              reason: error.code ?? 'unknown-error',
            }],
            ok: false,
          },
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    if (command === 'review-index') {
      process.stdout.write(
        serializeReviewIndexResult({
          file,
          result: {
            diagnostics: [{
              code: 'input-file-unreadable',
              column: 1,
              file,
              line: 1,
              reason: error.code ?? 'unknown-error',
            }],
            ok: false,
          },
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    if (command === 'profile') {
      process.stdout.write(
        serializeProfileResult({
          file,
          result: {
            diagnostics: [{
              code: 'input-file-unreadable',
              column: 1,
              file,
              line: 1,
              reason: error.code ?? 'unknown-error',
            }],
            ok: false,
          },
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    if ((command === 'audit' || command === 'check') && format === 'json') {
      process.stdout.write(
        serializeCheckResult({
          diagnostics: [
            {
              code: 'input-file-unreadable',
              column: 1,
              file,
              line: 1,
              reason: error.code ?? 'unknown-error',
            },
          ],
          file,
          ok: false,
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    process.stderr.write(`${file}: unable to read file (${error.code ?? 'unknown-error'})\n`)
    process.exitCode = EXIT_CHECK_FAILURE
    return
  }

  const decoded = decodeUtf8Source(sourceBytes, { file })
  if (!decoded.ok) {
    writeSourceFailure({
      command,
      diagnostics: decoded.diagnostics,
      file,
      factId,
      format,
      indexRevision,
      manifestFile,
      outDir,
    })
    process.exitCode = EXIT_CHECK_FAILURE
    return
  }
  const source = decoded.value

  if (command === 'translate') {
    const result = translateSource(source, { file })
    process.stdout.write(serializeTranslationResult({ file, result }))
    process.exitCode = result.ok ? 0 : EXIT_CHECK_FAILURE
    return
  }

  if (command === 'module-surface') {
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    } catch (error) {
      const code = error instanceof SyntaxError
        ? 'manifest-json-invalid'
        : 'manifest-file-unreadable'
      process.stdout.write(
        serializeModuleSurfaceResult({
          file,
          manifestFile,
          result: {
            diagnostics: [{ code, manifest_file: manifestFile }],
            ok: false,
          },
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    const lowered = lowerModuleSurface(source, manifest, { file })
    const result = lowered.ok
      ? {
          ok: true,
          value: {
            ...lowered.value,
            package_manifest_digest: packageManifestDigest(manifest),
          },
        }
      : lowered
    process.stdout.write(
      serializeModuleSurfaceResult({ file, manifestFile, result }),
    )
    if (!result.ok) process.exitCode = EXIT_CHECK_FAILURE
    return
  }

  if (command === 'review-index') {
    if (factId !== null || indexRevision !== null) {
      const expanded = factId === null || indexRevision === null
        ? {
            diagnostics: [{ code: 'review-fact-anchors-required' }],
            ok: false,
          }
        : reviewFactSource(source, { factId, indexRevision, file })
      process.stdout.write(serializeReviewFactResult({ file, result: expanded }))
      if (!expanded.ok) process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    const indexed = reviewIndexSource(source, {
      changedSince,
      cursor,
      file,
      limit,
    })
    process.stdout.write(serializeReviewIndexResult({ file, result: indexed }))
    if (!indexed.ok) process.exitCode = EXIT_CHECK_FAILURE
    return
  }

  if (command === 'profile') {
    const profiled = profileSource(source, { file })
    process.stdout.write(serializeProfileResult({ file, result: profiled }))
    if (!profiled.ok) process.exitCode = EXIT_CHECK_FAILURE
    return
  }

  if (command === 'build') {
    const result = buildSource(source, { file, sourceBytes })
    if (!result.ok) {
      process.stdout.write(serializeBuildResult({ outDir, result }))
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    try {
      await writeBuildArtifact(outDir, result.value.files)
    } catch (error) {
      process.stdout.write(
        serializeBuildResult({
          outDir,
          result: {
            diagnostics: [{
              code: 'build-write-failed',
              reason: error.code ?? 'unknown-error',
            }],
            ok: false,
          },
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    process.stdout.write(serializeBuildResult({ outDir, result }))
    return
  }

  if (command === 'patch') {
    let patch
    try {
      patch = JSON.parse(await readFile(patchFile, 'utf8'))
    } catch (error) {
      const code = error instanceof SyntaxError
        ? 'patch-json-invalid'
        : 'patch-file-unreadable'
      process.stdout.write(
        serializePatchResult({
          file,
          result: {
            diagnostics: [{ code, patch_file: patchFile }],
            ok: false,
          },
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }

    const result = patchSource(source, patch, { file })
    if (!result.ok) {
      process.stdout.write(serializePatchResult({ file, result }))
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    try {
      await writeCanonicalFile(file, serializeCanonicalGraph(result.program))
    } catch (error) {
      process.stdout.write(
        serializePatchResult({
          file,
          result: {
            diagnostics: [{
              code: 'patch-write-failed',
              reason: error.code ?? 'unknown-error',
            }],
            ok: false,
          },
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    process.stdout.write(serializePatchResult({ file, result }))
    return
  }

  if (command === 'manifest') {
    const reviewed = reviewSource(source, { file })
    process.stdout.write(
      serializeManifestResult({ file, result: reviewed }),
    )
    if (!reviewed.ok) process.exitCode = EXIT_CHECK_FAILURE
    return
  }

  if (command === 'audit') {
    const audited = auditSource(source, { file })
    if (!audited.ok) {
      process.stdout.write(
        serializeCheckResult({
          diagnostics: audited.diagnostics,
          file,
          ok: false,
        }),
      )
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    process.stdout.write(serializeAuditResult(audited.value))
    return
  }

  if (command === 'view') {
    const viewed = viewSource(source, { file, format, locale })
    if (!viewed.ok) {
      writeDiagnostics(viewed.diagnostics)
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    if (format === 'html') {
      process.stdout.write(viewed.value.html)
    } else if (format === 'svg') {
      process.stdout.write(viewed.value.svg)
    } else {
      process.stdout.write(viewed.value.text)
    }
    return
  }

  if (command === 'check') {
    const checked = checkSource(source, { file })
    if (format === 'json') {
      process.stdout.write(
        serializeCheckResult({
          diagnostics: checked.diagnostics,
          file,
          ok: checked.ok,
        }),
      )
      if (!checked.ok) process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    if (!checked.ok) {
      writeDiagnostics(checked.diagnostics)
      process.exitCode = EXIT_CHECK_FAILURE
      return
    }
    if (write) {
      try {
        await writeCanonicalFile(
          file,
          serializeCanonicalGraph(checked.program),
        )
      } catch (error) {
        process.stderr.write(
          `${file}: unable to write canonical RE (${error.code ?? 'unknown-error'})\n`,
        )
        process.exitCode = EXIT_CHECK_FAILURE
        return
      }
      process.stdout.write(`WROTE ${file}\n`)
      return
    }
    process.stdout.write(`OK ${file}\n`)
    return
  }

  const result = runSource(source, {
    argv: programArguments,
    file,
    fileSandboxRoot: dirname(resolve(file)),
  })
  if (result.outcome.kind === 'check-failure') {
    if (format === 'json') {
      process.stdout.write(serializeRunResult({
        outcome: result.outcome,
      }))
    } else {
      writeDiagnostics(result.outcome.diagnostics)
    }
    process.exitCode = EXIT_CHECK_FAILURE
    return
  }
  if (result.outcome.kind === 'host-fault') {
    if (format === 'json') {
      process.stdout.write(serializeRunResult({
        outcome: result.outcome,
      }))
    } else {
      process.stderr.write(`HOST_FAULT ${result.outcome.fault.code}\n`)
    }
    process.exitCode = EXIT_HOST_FAULT
    return
  }
  if (format === 'json') {
    process.stdout.write(serializeRunResult(result))
  } else {
    process.stdout.write(result.programStdout)
  }
  process.exitCode = result.outcome.status.code
}

function parseArguments(arguments_) {
  const [command, ...rest] = arguments_
  if (!['audit', 'build', 'check', 'manifest', 'module-surface', 'patch', 'profile', 'project-check', 'project-projection', 'project-run', 'project-translate', 'review-index', 'run', 'translate', 'view'].includes(command)) return { ok: false }

  if (command === 'project-check') {
    if (rest.shift() !== '--format' || rest.shift() !== 'json') {
      return { ok: false }
    }
    const file = rest.shift()
    if (file === undefined || rest.length > 0) return { ok: false }
    return {
      command,
      file,
      format: 'json',
      ok: true,
      programArguments: [],
      write: false,
    }
  }

  if (command === 'project-translate') {
    let locale = 'zh-CN'
    let format = 'json'
    while (rest[0]?.startsWith('--')) {
      const option = rest.shift()
      const value = rest.shift()
      if (value === undefined) return { ok: false }
      if (option === '--locale' && ['zh-CN', 'en-US'].includes(value)) locale = value
      else if (option === '--format' && ['json', 'text', 'html', 'svg'].includes(value)) format = value
      else return { ok: false }
    }
    const file = rest.shift()
    if (file === undefined || rest.length > 0) return { ok: false }
    return {
      command,
      file,
      format,
      locale,
      ok: true,
      programArguments: [],
      write: false,
    }
  }

  if (command === 'project-run') {
    if (rest.shift() !== '--fixture') return { ok: false }
    const fixtureFile = rest.shift()
    const file = rest.shift()
    if (fixtureFile === undefined || file === undefined || rest.length > 0) return { ok: false }
    return {
      command,
      file,
      fixtureFile,
      format: 'json',
      ok: true,
      programArguments: [],
      write: false,
    }
  }

  if (command === 'project-projection') {
    if (rest.shift() !== '--routes') return { ok: false }
    const routesFile = rest.shift()
    if (rest.shift() !== '--out') return { ok: false }
    const outDir = rest.shift()
    const file = rest.shift()
    if (
      routesFile === undefined
      || outDir === undefined
      || file === undefined
      || rest.length > 0
    ) {
      return { ok: false }
    }
    return {
      command,
      file,
      format: 'json',
      ok: true,
      outDir,
      programArguments: [],
      routesFile,
      write: false,
    }
  }

  if (command === 'build') {
    if (rest.shift() !== '--out') return { ok: false }
    const outDir = rest.shift()
    const file = rest.shift()
    if (outDir === undefined || file === undefined || rest.length > 0) {
      return { ok: false }
    }
    return {
      command,
      file,
      format: 'json',
      ok: true,
      outDir,
      programArguments: [],
      write: false,
    }
  }

  if (command === 'patch') {
    if (rest.shift() !== '--patch') return { ok: false }
    const patchFile = rest.shift()
    const file = rest.shift()
    if (patchFile === undefined || file === undefined || rest.length > 0) {
      return { ok: false }
    }
    return {
      command,
      file,
      format: 'json',
      ok: true,
      patchFile,
      programArguments: [],
      write: false,
    }
  }

  if (command === 'module-surface') {
    if (rest.shift() !== '--manifest') return { ok: false }
    const manifestFile = rest.shift()
    const file = rest.shift()
    if (manifestFile === undefined || file === undefined || rest.length > 0) {
      return { ok: false }
    }
    return {
      command,
      file,
      format: 'json',
      manifestFile,
      ok: true,
      programArguments: [],
      write: false,
    }
  }

  if (command === 'review-index') {
    const options = {
      changedSince: null,
      cursor: null,
      factId: null,
      indexRevision: null,
      limit: 50,
    }
    while (rest[0]?.startsWith('--')) {
      const option = rest.shift()
      const value = rest.shift()
      if (value === undefined) return { ok: false }
      if (option === '--changed-since') {
        options.changedSince = value
      } else if (option === '--cursor') {
        options.cursor = value
      } else if (option === '--fact-id') {
        options.factId = value
      } else if (option === '--index-revision') {
        options.indexRevision = value
      } else if (option === '--limit') {
        const limit = Number(value)
        if (!Number.isInteger(limit)) return { ok: false }
        options.limit = limit
      } else {
        return { ok: false }
      }
    }
    const file = rest.shift()
    if (file === undefined || rest.length > 0) return { ok: false }
    return {
      command,
      file,
      format: 'json',
      ok: true,
      programArguments: [],
      write: false,
      ...options,
    }
  }

  if (command === 'profile') {
    const file = rest.shift()
    if (file === undefined || rest.length > 0) return { ok: false }
    return {
      command,
      file,
      format: 'json',
      ok: true,
      programArguments: [],
      write: false,
    }
  }

  if (command === 'translate') {
    if (rest.shift() !== '--format' || rest.shift() !== 'json') {
      return { ok: false }
    }
    const file = rest.shift()
    if (file === undefined || rest.length > 0) return { ok: false }
    return {
      command,
      file,
      format: 'json',
      ok: true,
      programArguments: [],
      write: false,
    }
  }

  let format = 'text'
  let write = false
  if (command === 'run' && rest[0] === '--format') {
    if (rest[1] !== 'json') return { ok: false }
    format = 'json'
    rest.splice(0, 2)
  } else if (command === 'audit') {
    if (rest[0] !== '--format' || rest[1] !== 'json') return { ok: false }
    format = 'json'
    rest.splice(0, 2)
  } else if (command === 'view') {
    let locale = 'zh-CN'
    while (rest[0]?.startsWith('--')) {
      const option = rest.shift()
      const value = rest.shift()
      if (value === undefined) return { ok: false }
      if (option === '--format') {
        if (!['html', 'svg'].includes(value)) return { ok: false }
        format = value
      } else if (option === '--locale') {
        if (!['zh-CN', 'en-US'].includes(value)) return { ok: false }
        locale = value
      } else {
        return { ok: false }
      }
    }
    const file = rest.shift()
    if (file === undefined || rest.length > 0) return { ok: false }
    return { command, file, format, locale, ok: true, programArguments: [], write }
  } else if (command === 'check') {
    if (rest[0] === '--format') {
      if (rest[1] !== 'json') return { ok: false }
      format = 'json'
      rest.splice(0, 2)
    } else if (rest[0] === '--write') {
      write = true
      rest.shift()
    }
  }
  const file = rest.shift()
  if (file === undefined) return { ok: false }

  if (command === 'audit') {
    if (rest.length > 0) return { ok: false }
    return { command, file, format, ok: true, programArguments: [], write }
  }
  if (command === 'check' || command === 'view') {
    if (rest.length > 0) return { ok: false }
    return { command, file, format, ok: true, programArguments: [], write }
  }
  if (rest.length === 0) {
    return { command, file, format, ok: true, programArguments: [], write }
  }
  if (rest.shift() !== '--') return { ok: false }
  return { command, file, format, ok: true, programArguments: rest, write }
}

async function writeCanonicalFile(file, canonical) {
  const temporary = `${file}.canonical-${process.pid}`
  try {
    await writeFile(temporary, canonical, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function writeBuildArtifact(outDir, files) {
  const temporary = `${outDir}.tmp-${process.pid}`
  await rm(temporary, { force: true, recursive: true })
  try {
    await mkdir(temporary)
    for (const file of files) {
      const target = resolve(temporary, file.path)
      if (dirname(target) !== resolve(temporary)) {
        throw Object.assign(new Error('nested artifact paths are not supported'), {
          code: 'invalid-artifact-path',
        })
      }
      await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' })
      if (file.executable) await chmod(target, 0o755)
    }
    await rename(temporary, outDir)
  } catch (error) {
    await rm(temporary, { force: true, recursive: true })
    throw error
  }
}

function writeDiagnostics(diagnostics) {
  for (const diagnostic of diagnostics) {
    const location = [
      diagnostic.file ?? '<input>',
      diagnostic.line ?? 1,
      diagnostic.column ?? 1,
    ].join(':')
    process.stderr.write(`${location}: ${diagnostic.code}${detailOf(diagnostic)}\n`)
  }
}

function writeSourceFailure({
  command,
  diagnostics,
  factId,
  file,
  format,
  indexRevision,
  manifestFile,
  outDir,
}) {
  if ((command === 'audit' || command === 'check') && format === 'json') {
    process.stdout.write(serializeCheckResult({ diagnostics, file, ok: false }))
    return
  }
  if (command === 'patch') {
    process.stdout.write(
      serializePatchResult({ file, result: { diagnostics, ok: false } }),
    )
    return
  }
  if (command === 'manifest') {
    process.stdout.write(
      serializeManifestResult({ file, result: { diagnostics, ok: false } }),
    )
    return
  }
  if (command === 'build') {
    process.stdout.write(
      serializeBuildResult({
        outDir,
        result: { diagnostics, ok: false },
      }),
    )
    return
  }
  if (command === 'review-index' && (factId !== null || indexRevision !== null)) {
    process.stdout.write(
      serializeReviewFactResult({ file, result: { diagnostics, ok: false } }),
    )
    return
  }
  if (command === 'review-index') {
    process.stdout.write(
      serializeReviewIndexResult({ file, result: { diagnostics, ok: false } }),
    )
    return
  }
  if (command === 'profile') {
    process.stdout.write(
      serializeProfileResult({ file, result: { diagnostics, ok: false } }),
    )
    return
  }
  if (command === 'translate') {
    process.stdout.write(
      serializeTranslationResult({
        file,
        result: { diagnostics, ok: false },
      }),
    )
    return
  }
  if (command === 'module-surface') {
    process.stdout.write(
      serializeModuleSurfaceResult({
        file,
        manifestFile,
        result: { diagnostics, ok: false },
      }),
    )
    return
  }
  if (command === 'run' && format === 'json') {
    process.stdout.write(
      serializeRunResult({
        outcome: {
          diagnostics,
          kind: 'check-failure',
        },
      }),
    )
    return
  }
  writeDiagnostics(diagnostics)
}

function detailOf(diagnostic) {
  const details = []
  if (diagnostic.expected !== undefined) {
    details.push(
      `expected ${formatDiagnosticValue(diagnostic.expected)}, got ${formatDiagnosticValue(diagnostic.actual)}`,
    )
  }
  if (diagnostic.phase !== undefined) details.push(`phase ${diagnostic.phase}`)
  if (diagnostic.rule !== undefined) details.push(`rule ${diagnostic.rule}`)
  if (diagnostic.repair !== undefined) details.push(`repair ${formatRepair(diagnostic.repair)}`)
  return details.length === 0 ? '' : ` (${details.join('; ')})`
}

function formatDiagnosticValue(value) {
  return Array.isArray(value) ? value.join('|') : String(value)
}

function formatRepair(repair) {
  if (repair === null || typeof repair !== 'object') return String(repair)
  if (repair.action === 'inspect' && repair.rule !== undefined) {
    return `inspect ${repair.rule}`
  }
  if (repair.expected !== undefined) {
    return `${repair.action} ${formatDiagnosticValue(repair.expected)}`
  }
  return String(repair.action ?? 'inspect')
}
