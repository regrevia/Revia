import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { loadCanonicalGraph } from '../src/toolchain/canonical.js'
import {
  moduleInterfaceDigest,
  packageManifestDigest,
} from '../src/toolchain/module-contract.js'
import { graphRevision } from '../src/toolchain/structured-patch.js'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const cli = fileURLToPath(new URL('../src/cli/re.js', import.meta.url))

function runCli(...arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
}

test('re check accepts the checked-in Hello World program', () => {
  const result = runCli('check', 'examples/hello.re')

  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'OK examples/hello.re\n')
  assert.equal(result.stderr, '')
})

test('re check exposes a deterministic machine-readable result for AI tools', () => {
  const result = runCli(
    'check',
    '--format',
    'json',
    'examples/hello.re',
  )

  assert.equal(result.status, 0)
  assert.equal(
    result.stdout,
    '{"diagnostics":[],"file":"examples/hello.re","ok":true,"schema":"re.check-result@0.1.0"}\n',
  )
  assert.equal(result.stderr, '')
})

test('machine-readable check failure includes repair context', () => {
  const result = runCli(
    'check',
    '--format',
    'json',
    'test/fixtures/wrong-argument.re',
  )

  assert.equal(result.status, 65)
  assert.equal(
    result.stdout,
    '{"diagnostics":[{"actual":"message","code":"unexpected-argument","column":28,"expected":["data"],"file":"test/fixtures/wrong-argument.re","line":6,"member":"write","reference":"process.stdout@0.1.0"}],"file":"test/fixtures/wrong-argument.re","ok":false,"schema":"re.check-result@0.1.0"}\n',
  )
  assert.equal(result.stderr, '')
})

test('machine-readable check keeps input failures inside the JSON protocol', () => {
  const result = runCli(
    'check',
    '--format',
    'json',
    'test/fixtures/does-not-exist.re',
  )

  assert.equal(result.status, 65)
  assert.equal(
    result.stdout,
    '{"diagnostics":[{"code":"input-file-unreadable","column":1,"file":"test/fixtures/does-not-exist.re","line":1,"reason":"ENOENT"}],"file":"test/fixtures/does-not-exist.re","ok":false,"schema":"re.check-result@0.1.0"}\n',
  )
  assert.equal(result.stderr, '')
})

test('machine-readable check rejects invalid UTF-8 without replacement', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-invalid-utf8-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'invalid.re')
  await writeFile(file, Buffer.from([0x72, 0x65, 0x0a, 0xc0, 0x80]))

  const result = runCli('check', '--format', 'json', file)

  assert.equal(result.status, 65)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), {
    diagnostics: [{
      byte_offset: 3,
      code: 'invalid-utf8-source',
      column: 1,
      file,
      line: 2,
    }],
    file,
    ok: false,
    schema: 're.check-result@0.1.0',
  })
})

test('re run executes Hello World and exposes only program stdout', () => {
  const result = runCli('run', 'examples/hello.re')

  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'Hello, World!\n')
  assert.equal(result.stderr, '')
})

test('re run --format json emits the versioned process-status envelope', () => {
  const result = runCli('run', '--format', 'json', 'examples/hello.re')

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.equal(
    result.stdout,
    '{"outcome":{"kind":"process-status","status":{"code":0}},"program_stdout":"Hello, World!\\n","schema":"re.run-result@0.1.0"}\n',
  )
})

test('re run --format json keeps check failures and unreadable input in the run envelope', () => {
  const failed = runCli(
    'run',
    '--format',
    'json',
    'test/fixtures/wrong-argument.re',
  )
  assert.equal(failed.status, 65)
  assert.equal(failed.stderr, '')
  const failedOutput = JSON.parse(failed.stdout)
  assert.equal(failedOutput.schema, 're.run-result@0.1.0')
  assert.equal(failedOutput.outcome.kind, 'check-failure')
  assert.equal(failedOutput.outcome.diagnostics[0].code, 'unexpected-argument')
  assert.equal(failedOutput.program_stdout, '')

  const unreadable = runCli(
    'run',
    '--format',
    'json',
    'test/fixtures/does-not-exist.re',
  )
  assert.equal(unreadable.status, 65)
  assert.equal(unreadable.stderr, '')
  assert.deepEqual(JSON.parse(unreadable.stdout), {
    outcome: {
      diagnostics: [{
        code: 'input-file-unreadable',
        column: 1,
        file: 'test/fixtures/does-not-exist.re',
        line: 1,
        reason: 'ENOENT',
      }],
      kind: 'check-failure',
    },
    program_stdout: '',
    schema: 're.run-result@0.1.0',
  })
})

test('re run passes program arguments to an executable process args source', () => {
  const result = runCli(
    'run',
    'examples/args-check.re',
    '--',
    'alpha',
    'β',
  )

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('re run binds file capabilities to the source directory sandbox', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-file-sandbox-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const readProgram = join(directory, 'read-check.re')
  const writeProgram = join(directory, 'write-check.re')
  await writeFile(
    readProgram,
    await readFile(new URL('../examples/read-check.re', import.meta.url), 'utf8'),
    'utf8',
  )
  await writeFile(
    writeProgram,
    await readFile(new URL('../examples/write-check.re', import.meta.url), 'utf8'),
    'utf8',
  )
  await writeFile(join(directory, 'input.txt'), 'sandbox input', 'utf8')

  const read = runCli('run', readProgram)
  const write = runCli('run', writeProgram)

  assert.equal(read.status, 0)
  assert.equal(read.stdout, '')
  assert.equal(read.stderr, '')
  assert.equal(write.status, 0)
  assert.equal(write.stdout, '')
  assert.equal(write.stderr, '')
  assert.deepEqual(
    await readFile(join(directory, 'output.txt')),
    Buffer.from([0x41, 0x00, 0x42]),
  )
})

test('re run file sandbox rejects a path above the source directory', async (context) => {
  const parent = await mkdtemp(join(tmpdir(), 're-file-outside-'))
  context.after(() => rm(parent, { force: true, recursive: true }))
  const directory = join(parent, 'sandbox')
  const source = (
    await readFile(new URL('../examples/write-check.re', import.meta.url), 'utf8')
  ).replace('"output.txt"', '"../outside.txt"')
  await mkdir(directory)
  const program = join(directory, 'write-outside.re')
  await writeFile(program, source, 'utf8')

  const result = runCli('run', program)

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  await assert.rejects(access(join(parent, 'outside.txt')))
})

test('re audit exposes deterministic static JSON without executing effects', () => {
  const result = runCli('audit', '--format', 'json', 'test/golden/canonical-hello.re')

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.equal(
    result.stdout,
    '{"capabilities":[{"binding_kind":"memory","instance":"@stdout","reference":"process.stdout@0.1.0"}],"effects":[{"access":["write process.stdout"],"capability_instance":"@stdout","member":"write","node_uid":"aaaaaadaaaaaaaaaaaaaaaaaaa","result_consumers":["aaaaaafaaaaaaaaaaaaaaaaaaa"],"returns":"result<unit, io.write_error>"}],"error_paths":[{"consumer_uid":"aaaaaafaaaaaaaaaaaaaaaaaaa","error_type":"io.write_error","producer_uid":"aaaaaadaaaaaaaaaaaaaaaaaaa","status_codes":[1]}],"schema":"re.audit-result@0.1.0","status_codes":[0,1]}\n',
  )
})

test('re audit classifies local file capabilities without opening files', () => {
  const result = runCli('audit', '--format', 'json', 'test/golden/canonical-read-check.re')

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.capabilities, [{
    binding_kind: 'local',
    instance: '@input',
    reference: 'fs.read@0.1.0',
  }])
  assert.deepEqual(output.status_codes, [0, 2])
  assert.equal(output.error_paths[0].error_type, 'fs.read_error')
})

test('re audit reports check failures as stable JSON', () => {
  const result = runCli('audit', '--format', 'json', 'test/fixtures/wrong-argument.re')

  assert.equal(result.status, 65)
  assert.equal(result.stderr, '')
  assert.equal(
    result.stdout,
    '{"diagnostics":[{"actual":"message","code":"unexpected-argument","column":28,"expected":["data"],"file":"test/fixtures/wrong-argument.re","line":6,"member":"write","reference":"process.stdout@0.1.0"}],"file":"test/fixtures/wrong-argument.re","ok":false,"schema":"re.check-result@0.1.0"}\n',
  )
})

test('re audit keeps input failures inside the JSON protocol', () => {
  const result = runCli(
    'audit',
    '--format',
    'json',
    'test/fixtures/does-not-exist.re',
  )

  assert.equal(result.status, 65)
  assert.equal(result.stderr, '')
  assert.equal(
    result.stdout,
    '{"diagnostics":[{"code":"input-file-unreadable","column":1,"file":"test/fixtures/does-not-exist.re","line":1,"reason":"ENOENT"}],"file":"test/fixtures/does-not-exist.re","ok":false,"schema":"re.check-result@0.1.0"}\n',
  )
})

test('re view renders a deterministic Chinese semantic summary', () => {
  const result = runCli('view', 'test/golden/canonical-hello.re')

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.equal(
    result.stdout,
    'RE 语义视图 0.1\n单位：@hello\n图修订：sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083\n能力：\n- @stdout 使用 process.stdout@0.1.0（memory，证据 aaaaaaaaaaaaaaaaaaaaaaaaaa）\n效果：\n- aaaaaadaaaaaaaaaaaaaaaaaaa 调用 @stdout.write；访问 write process.stdout；返回 result<unit, io.write_error>；消费者 aaaaaafaaaaaaaaaaaaaaaaaaa\n错误路径：\n- aaaaaadaaaaaaaaaaaaaaaaaaa 的 io.write_error 由 aaaaaafaaaaaaaaaaaaaaaaaaa 消费；可能退出 1\n退出码：\n- 0, 1\n',
  )
})

test('re view renders deterministic English text from the same facts', () => {
  const first = runCli('view', '--locale', 'en-US', 'test/golden/canonical-hello.re')
  const second = runCli('view', '--locale', 'en-US', 'test/golden/canonical-hello.re')

  assert.equal(first.status, 0)
  assert.equal(first.stderr, '')
  assert.equal(second.status, 0)
  assert.equal(second.stderr, '')
  assert.equal(first.stdout, second.stdout)
  assert.equal(
    first.stdout,
    'RE Semantic View 0.1\nUnit: @hello\nGraph revision: sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083\nCapabilities:\n- @stdout uses process.stdout@0.1.0 (memory, evidence aaaaaaaaaaaaaaaaaaaaaaaaaa)\nEffects:\n- aaaaaadaaaaaaaaaaaaaaaaaaa calls @stdout.write; access write process.stdout; returns result<unit, io.write_error>; consumers aaaaaafaaaaaaaaaaaaaaaaaaa\nError paths:\n- aaaaaadaaaaaaaaaaaaaaaaaaa io.write_error is consumed by aaaaaafaaaaaaaaaaaaaaaaaaa; possible exit 1\nStatus codes:\n- 0, 1\n',
  )
})

test('re view rejects unsupported locales at usage parsing', () => {
  const result = runCli('view', '--locale', 'fr-FR', 'test/golden/canonical-hello.re')

  assert.equal(result.status, 64)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /re view \[--locale zh-CN\|en-US\]/)
})

test('re view renders deterministic HTML from the semantic view IR', () => {
  const first = runCli('view', '--format', 'html', 'test/golden/canonical-hello.re')
  const second = runCli('view', '--format', 'html', 'test/golden/canonical-hello.re')

  assert.equal(first.status, 0)
  assert.equal(first.stderr, '')
  assert.equal(second.status, 0)
  assert.equal(second.stderr, '')
  assert.equal(first.stdout, second.stdout)
  assert.match(first.stdout, /^<!doctype html>\n<html lang="zh-CN">/)
  assert.match(first.stdout, /data-schema="re.semantic-view-ir@0.1.0"/)
  assert.match(first.stdout, /data-revision="sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083"/)
  assert.match(first.stdout, /<h2>能力<\/h2>/)
  assert.match(first.stdout, /<code>capability:@stdout<\/code>/)
  assert.match(first.stdout, /<code>effect:aaaaaadaaaaaaaaaaaaaaaaaaa<\/code>/)
  assert.match(first.stdout, /<code>error-path:aaaaaadaaaaaaaaaaaaaaaaaaa:io.write_error:aaaaaafaaaaaaaaaaaaaaaaaaa<\/code>/)
})

test('re view renders deterministic SVG from the semantic view IR', () => {
  const first = runCli('view', '--format', 'svg', 'test/golden/canonical-hello.re')
  const second = runCli('view', '--format', 'svg', 'test/golden/canonical-hello.re')

  assert.equal(first.status, 0)
  assert.equal(first.stderr, '')
  assert.equal(second.status, 0)
  assert.equal(second.stderr, '')
  assert.equal(first.stdout, second.stdout)
  assert.match(first.stdout, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(first.stdout, /data-schema="re.semantic-view-ir@0.1.0"/)
  assert.match(first.stdout, /data-revision="sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083"/)
  assert.match(first.stdout, /data-fact-id="capability:@stdout" data-evidence-uid="aaaaaaaaaaaaaaaaaaaaaaaaaa"/)
  assert.match(first.stdout, /data-fact-id="effect:aaaaaadaaaaaaaaaaaaaaaaaaa" data-evidence-uid="aaaaaadaaaaaaaaaaaaaaaaaaa"/)
  assert.match(first.stdout, /@stdout -&gt; process\.stdout@0\.1\.0/)
})

test('re view reports check failures as human diagnostics', () => {
  const result = runCli('view', 'test/fixtures/wrong-argument.re')

  assert.equal(result.status, 65)
  assert.equal(result.stdout, '')
  assert.equal(
    result.stderr,
    'test/fixtures/wrong-argument.re:6:28: unexpected-argument (expected data, got message)\n',
  )
})

test('re build writes a deterministic runnable artifact stub', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-build-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const firstOut = join(directory, 'artifact-a')
  const secondOut = join(directory, 'artifact-b')

  const first = runCli('build', '--out', firstOut, 'test/golden/canonical-hello.re')
  const second = runCli('build', '--out', secondOut, 'test/golden/canonical-hello.re')

  assert.equal(first.status, 0)
  assert.equal(first.stderr, '')
  assert.equal(second.status, 0)
  assert.equal(second.stderr, '')
  const output = JSON.parse(first.stdout)
  assert.equal(output.ok, true)
  assert.equal(output.schema, 're.build-result@0.1.0')
  assert.equal(output.out_dir, firstOut)
  assert.equal(output.artifact.schema, 're.build-artifact@0.1.0')
  assert.match(output.artifact.build_key, /^sha256:[0-9a-f]{64}$/)
  assert.equal(output.artifact.graph_revision, 'sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083')
  assert.equal(output.artifact.target_profile, 'node-demo-self-contained-preview@0.1.0')
  assert.deepEqual(output.artifact.runtime, {
    entrypoint: 'run.mjs',
    kind: 'self-contained-node-demo-runtime',
  })
  assert.deepEqual(output.artifact.required_capabilities, [{
    binding_kind: 'memory',
    instance: '@stdout',
    reference: 'process.stdout@0.1.0',
  }])
  assert.deepEqual(
    output.artifact.files.map(({ path }) => path),
    ['program.re', 'release-lock.json', 'run.mjs', 'review-index.json', 'semantic-view.json'],
  )
  const firstManifest = await readFile(join(firstOut, 'manifest.json'), 'utf8')
  const secondManifest = await readFile(join(secondOut, 'manifest.json'), 'utf8')
  const firstChecksums = await readFile(join(firstOut, 'checksums.sha256'), 'utf8')
  const secondChecksums = await readFile(join(secondOut, 'checksums.sha256'), 'utf8')
  assert.equal(firstManifest, secondManifest)
  assert.equal(firstChecksums, secondChecksums)
  assert.equal(
    sha256Hex(firstManifest),
    output.artifact.manifest_sha256,
  )
  assert.equal(
    sha256Hex(firstChecksums),
    output.artifact.checksums_sha256,
  )
  assert.match(output.artifact.module_interface_digest, /^sha256:[0-9a-f]{64}$/)
  const releaseLock = JSON.parse(await readFile(join(firstOut, 'release-lock.json'), 'utf8'))
  assert.deepEqual(output.artifact.preview_release.release_lock, {
    path: 'release-lock.json',
    schema: 're.release-lock@0.1.0',
    sha256: sha256Hex(await readFile(join(firstOut, 'release-lock.json'), 'utf8')),
  })
  assert.equal(releaseLock.schema, 're.release-lock@0.1.0')
  assert.equal(releaseLock.build_key, output.artifact.build_key)
  assert.equal(releaseLock.canonical.graph_revision, output.artifact.graph_revision)
  assert.deepEqual(releaseLock.identity_allocator, {
    algorithm: 're.deterministic-uid-sequence@0.1.0',
    schema: 're.identity-allocator@0.1.0',
  })
  assert.deepEqual(output.artifact.identity_allocator, releaseLock.identity_allocator)
  assert.equal(releaseLock.module_interface_digest, output.artifact.module_interface_digest)
  assert.equal(releaseLock.runtime.target_profile, output.artifact.target_profile)
  assert.equal(JSON.stringify(releaseLock).includes(firstOut), false)
  assert.equal(JSON.stringify(releaseLock).includes('test/golden'), false)
  assert.deepEqual(output.artifact.preview_release.review_index, {
    path: 'review-index.json',
    revision: JSON.parse(await readFile(join(firstOut, 'review-index.json'), 'utf8')).index_revision,
    schema: 're.project-review-index@0.1.0',
  })
  assert.equal(output.artifact.preview_release.semantic_view.path, 'semantic-view.json')
  assert.equal(output.artifact.preview_release.semantic_view.schema, 're.semantic-view-ir@0.1.0')
  assert.equal(
    output.artifact.preview_release.semantic_view.sha256,
    sha256Hex(await readFile(join(firstOut, 'semantic-view.json'), 'utf8')),
  )
  assert.equal(
    firstChecksums,
    [
      `${sha256Hex(firstManifest)}  manifest.json\n`,
      `${sha256Hex(await readFile(join(firstOut, 'program.re'), 'utf8'))}  program.re\n`,
      `${sha256Hex(await readFile(join(firstOut, 'release-lock.json'), 'utf8'))}  release-lock.json\n`,
      `${sha256Hex(await readFile(join(firstOut, 'review-index.json'), 'utf8'))}  review-index.json\n`,
      `${sha256Hex(await readFile(join(firstOut, 'run.mjs'), 'utf8'))}  run.mjs\n`,
      `${sha256Hex(await readFile(join(firstOut, 'semantic-view.json'), 'utf8'))}  semantic-view.json\n`,
    ].join(''),
  )
  assert.equal(JSON.stringify(output.artifact).includes(firstOut), false)
  assert.equal(JSON.stringify(output.artifact).includes('test/golden'), false)
  assert.equal(
    await readFile(join(firstOut, 'program.re'), 'utf8'),
    await readFile(new URL('../test/golden/canonical-hello.re', import.meta.url), 'utf8'),
  )
  assert.ok((await stat(join(firstOut, 'run.mjs'))).mode & 0o111)
  assert.equal((await readFile(join(firstOut, 'run.mjs'), 'utf8')).includes('spawnSync'), false)

  const run = spawnSync(process.execPath, [join(firstOut, 'run.mjs')], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: '', RE_CLI: '/definitely/not/re' },
  })
  assert.equal(run.status, 0)
  assert.equal(run.stdout, 'Hello, World!\n')
  assert.equal(run.stderr, '')

  await writeFile(join(secondOut, 'program.re'), 'tampered artifact\n', 'utf8')
  const tamperedProgramRun = spawnSync(process.execPath, [join(secondOut, 'run.mjs')], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: '', RE_CLI: '/definitely/not/re' },
  })
  assert.equal(tamperedProgramRun.status, 70)
  assert.equal(tamperedProgramRun.stdout, '')
  assert.equal(
    tamperedProgramRun.stderr,
    're artifact runtime error: artifact checksum mismatch: program.re\n',
  )
  await writeFile(
    join(secondOut, 'program.re'),
    await readFile(join(firstOut, 'program.re'), 'utf8'),
    'utf8',
  )

  const secondLockPath = join(secondOut, 'release-lock.json')
  const runSecondArtifact = () => spawnSync(process.execPath, [join(secondOut, 'run.mjs')], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: '', RE_CLI: '/definitely/not/re' },
  })
  const assertArtifactFailure = (failed, reason) => {
    assert.equal(failed.status, 70)
    assert.equal(failed.stdout, '')
    assert.equal(failed.stderr, `re artifact runtime error: ${reason}\n`)
  }
  const updateChecksumEntry = async (out, path) => {
    const checksumPath = join(out, 'checksums.sha256')
    const replacement = `${sha256Hex(await readFile(join(out, path)))}  ${path}`
    const lines = (await readFile(checksumPath, 'utf8')).trimEnd().split('\n')
    const index = lines.findIndex((line) => line.endsWith(`  ${path}`))
    assert.notEqual(index, -1)
    lines[index] = replacement
    await writeFile(checksumPath, `${lines.join('\n')}\n`, 'utf8')
  }
  const syncManifestReleaseLockDigest = async (out) => {
    const manifestPath = join(out, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.preview_release.release_lock.sha256 = sha256Hex(
      await readFile(join(out, 'release-lock.json')),
    )
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
    await updateChecksumEntry(out, 'manifest.json')
  }

  const secondChecksumsPath = join(secondOut, 'checksums.sha256')
  const originalSecondChecksums = await readFile(secondChecksumsPath, 'utf8')
  await rm(secondChecksumsPath)
  assertArtifactFailure(runSecondArtifact(), 'artifact checksum file unreadable')

  await writeFile(secondChecksumsPath, 'not-a-checksum\n', 'utf8')
  assertArtifactFailure(runSecondArtifact(), 'artifact checksum file malformed')

  const firstChecksumLine = originalSecondChecksums.split('\n')[0]
  await writeFile(
    secondChecksumsPath,
    `${originalSecondChecksums}${firstChecksumLine}\n`,
    'utf8',
  )
  assertArtifactFailure(runSecondArtifact(), 'artifact checksum duplicate entry: manifest.json')

  await writeFile(
    secondChecksumsPath,
    `${originalSecondChecksums}${'0'.repeat(64)}  unknown.txt\n`,
    'utf8',
  )
  assertArtifactFailure(runSecondArtifact(), 'artifact checksum unknown entry: unknown.txt')

  await writeFile(
    secondChecksumsPath,
    originalSecondChecksums
      .split('\n')
      .filter((line) => !line.endsWith('  program.re'))
      .join('\n'),
    'utf8',
  )
  assertArtifactFailure(runSecondArtifact(), 'artifact checksum missing entry: program.re')
  await writeFile(secondChecksumsPath, originalSecondChecksums, 'utf8')

  const secondManifestPath = join(secondOut, 'manifest.json')
  await writeFile(secondManifestPath, '{', 'utf8')
  await updateChecksumEntry(secondOut, 'manifest.json')
  assertArtifactFailure(runSecondArtifact(), 'artifact manifest invalid JSON')
  await writeFile(
    secondManifestPath,
    await readFile(join(firstOut, 'manifest.json'), 'utf8'),
    'utf8',
  )
  await writeFile(secondChecksumsPath, originalSecondChecksums, 'utf8')

  const secondManifestObject = JSON.parse(await readFile(secondManifestPath, 'utf8'))
  await writeFile(
    secondManifestPath,
    JSON.stringify({ ...secondManifestObject, build_key: `sha256:${'0'.repeat(64)}` }),
    'utf8',
  )
  await updateChecksumEntry(secondOut, 'manifest.json')
  assertArtifactFailure(runSecondArtifact(), 'artifact manifest build key mismatch')

  await writeFile(
    secondManifestPath,
    JSON.stringify({
      ...secondManifestObject,
      preview_release: {
        ...secondManifestObject.preview_release,
        release_lock: {
          ...secondManifestObject.preview_release.release_lock,
          sha256: '0'.repeat(64),
        },
      },
    }),
    'utf8',
  )
  await updateChecksumEntry(secondOut, 'manifest.json')
  assertArtifactFailure(runSecondArtifact(), 'artifact manifest release lock digest mismatch')
  await writeFile(
    secondManifestPath,
    await readFile(join(firstOut, 'manifest.json'), 'utf8'),
    'utf8',
  )
  await writeFile(secondChecksumsPath, originalSecondChecksums, 'utf8')

  await rm(secondLockPath)
  assertArtifactFailure(runSecondArtifact(), 'artifact file unreadable: release-lock.json')

  await writeFile(secondLockPath, '{', 'utf8')
  await updateChecksumEntry(secondOut, 'release-lock.json')
  await syncManifestReleaseLockDigest(secondOut)
  assertArtifactFailure(runSecondArtifact(), 'release lock invalid JSON')

  for (const [name, mutation] of [
    ['schema mismatch', { schema: 're.release-lock@9.0.0' }],
    ['build key mismatch', { build_key: `sha256:${'0'.repeat(64)}` }],
    ['graph revision mismatch', {
      canonical: { ...releaseLock.canonical, graph_revision: `sha256:${'0'.repeat(64)}` },
    }],
    ['runtime kind mismatch', {
      runtime: { ...releaseLock.runtime, kind: 'external-runtime' },
    }],
    ['target profile mismatch', {
      runtime: { ...releaseLock.runtime, target_profile: 'other-profile@0.1.0' },
    }],
  ]) {
    await writeFile(secondLockPath, JSON.stringify({ ...releaseLock, ...mutation }), 'utf8')
    await updateChecksumEntry(secondOut, 'release-lock.json')
    await syncManifestReleaseLockDigest(secondOut)
    assertArtifactFailure(runSecondArtifact(), `release lock ${name}`)
  }

  const alteredAllocator = {
    algorithm: 're.other-allocator@9.0.0',
    schema: 're.identity-allocator@0.1.0',
  }
  await writeFile(
    secondLockPath,
    JSON.stringify({ ...releaseLock, identity_allocator: alteredAllocator }),
    'utf8',
  )
  await updateChecksumEntry(secondOut, 'release-lock.json')
  await writeFile(
    secondManifestPath,
    JSON.stringify({
      ...secondManifestObject,
      preview_release: {
        ...secondManifestObject.preview_release,
        release_lock: {
          ...secondManifestObject.preview_release.release_lock,
          sha256: sha256Hex(await readFile(secondLockPath)),
        },
      },
    }),
    'utf8',
  )
  await updateChecksumEntry(secondOut, 'manifest.json')
  assertArtifactFailure(runSecondArtifact(), 'release lock identity allocator mismatch')
  await writeFile(
    secondLockPath,
    await readFile(join(firstOut, 'release-lock.json'), 'utf8'),
    'utf8',
  )
  await writeFile(
    secondManifestPath,
    await readFile(join(firstOut, 'manifest.json'), 'utf8'),
    'utf8',
  )
  await writeFile(secondChecksumsPath, originalSecondChecksums, 'utf8')

  await writeFile(
    secondLockPath,
    JSON.stringify({ ...releaseLock, identity_allocator: alteredAllocator }),
    'utf8',
  )
  await updateChecksumEntry(secondOut, 'release-lock.json')
  await writeFile(
    secondManifestPath,
    JSON.stringify({
      ...secondManifestObject,
      identity_allocator: alteredAllocator,
      preview_release: {
        ...secondManifestObject.preview_release,
        release_lock: {
          ...secondManifestObject.preview_release.release_lock,
          sha256: sha256Hex(await readFile(secondLockPath)),
        },
      },
    }),
    'utf8',
  )
  await updateChecksumEntry(secondOut, 'manifest.json')
  assertArtifactFailure(
    runSecondArtifact(),
    'artifact manifest identity allocator mismatch',
  )
  await writeFile(
    secondManifestPath,
    await readFile(join(firstOut, 'manifest.json'), 'utf8'),
    'utf8',
  )
  await writeFile(secondChecksumsPath, originalSecondChecksums, 'utf8')

  const absoluteInput = join(directory, 'absolute-input.re')
  const absoluteOut = join(directory, 'absolute-artifact')
  const canonicalHello = await readFile(
    new URL('../test/golden/canonical-hello.re', import.meta.url),
    'utf8',
  )
  await writeFile(absoluteInput, canonicalHello, 'utf8')
  const absoluteBuild = runCli('build', '--out', absoluteOut, absoluteInput)
  assert.equal(absoluteBuild.status, 0)
  assert.equal(absoluteBuild.stderr, '')
  const absoluteRunner = await readFile(join(absoluteOut, 'run.mjs'), 'utf8')
  assert.equal(absoluteRunner.includes(absoluteInput), false)
  assert.equal(absoluteRunner.includes(directory), false)

  const argsOut = join(directory, 'artifact-args')
  const argsBuild = runCli('build', '--out', argsOut, 'examples/args-check.re')
  assert.equal(argsBuild.status, 0)
  assert.equal(argsBuild.stderr, '')
  const argsRun = spawnSync(process.execPath, [join(argsOut, 'run.mjs'), 'alpha', 'β'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: '', RE_CLI: '/definitely/not/re' },
  })
  assert.equal(argsRun.status, 0)
  assert.equal(argsRun.stdout, '')
  assert.equal(argsRun.stderr, '')

  const readOut = join(directory, 'artifact-read')
  const readBuild = runCli('build', '--out', readOut, 'examples/read-check.re')
  assert.equal(readBuild.status, 0)
  assert.equal(readBuild.stderr, '')
  await writeFile(join(readOut, 'input.txt'), 'artifact input', 'utf8')
  const readRun = spawnSync(process.execPath, [join(readOut, 'run.mjs')], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: '', RE_CLI: '/definitely/not/re' },
  })
  assert.equal(readRun.status, 0)
  assert.equal(readRun.stdout, '')
  assert.equal(readRun.stderr, '')

  const writeOut = join(directory, 'artifact-write')
  const writeBuild = runCli('build', '--out', writeOut, 'examples/write-check.re')
  assert.equal(writeBuild.status, 0)
  assert.equal(writeBuild.stderr, '')
  const writeRun = spawnSync(process.execPath, [join(writeOut, 'run.mjs')], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: '', RE_CLI: '/definitely/not/re' },
  })
  assert.equal(writeRun.status, 0)
  assert.equal(writeRun.stdout, '')
  assert.equal(writeRun.stderr, '')
  assert.deepEqual(await readFile(join(writeOut, 'output.txt')), Buffer.from([0x41, 0x00, 0x42]))

  await rm(join(writeOut, 'output.txt'))
  const writeLockPath = join(writeOut, 'release-lock.json')
  const writeLock = JSON.parse(await readFile(writeLockPath, 'utf8'))
  await writeFile(
    writeLockPath,
    JSON.stringify({ ...writeLock, build_key: `sha256:${'0'.repeat(64)}` }),
    'utf8',
  )
  const rejectedWriteRun = spawnSync(process.execPath, [join(writeOut, 'run.mjs')], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: '', RE_CLI: '/definitely/not/re' },
  })
  assertArtifactFailure(rejectedWriteRun, 'artifact checksum mismatch: release-lock.json')
  await assert.rejects(access(join(writeOut, 'output.txt')), { code: 'ENOENT' })
})

test('re build failure leaves an existing output directory untouched', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-build-existing-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const out = join(directory, 'artifact')
  await mkdir(out)
  await writeFile(join(out, 'keep.txt'), 'keep', 'utf8')

  const result = runCli('build', '--out', out, 'test/golden/canonical-hello.re')

  assert.equal(result.status, 65)
  assert.equal(result.stderr, '')
  assert.equal(await readFile(join(out, 'keep.txt'), 'utf8'), 'keep')
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, false)
  assert.equal(output.schema, 're.build-result@0.1.0')
  assert.equal(output.out_dir, out)
  assert.equal(output.diagnostics[0].code, 'build-write-failed')
  assert.deepEqual(
    (await readdir(directory)).filter((entry) => entry.startsWith('artifact.tmp-')),
    [],
  )
})

test('re review-index emits deterministic project facts for agents', () => {
  const first = runCli('review-index', '--limit', '2', 'test/golden/canonical-hello.re')
  const second = runCli('review-index', '--limit', '2', 'test/golden/canonical-hello.re')

  assert.equal(first.status, 0)
  assert.equal(first.stderr, '')
  assert.equal(second.status, 0)
  assert.equal(second.stderr, '')
  assert.equal(first.stdout, second.stdout)
  const output = JSON.parse(first.stdout)
  assert.equal(output.ok, true)
  assert.equal(output.file, 'test/golden/canonical-hello.re')
  assert.equal(output.schema, 're.project-review-index-result@0.1.0')
  assert.equal(output.index.schema, 're.project-review-index@0.1.0')
  assert.equal(output.index.graph_revision, 'sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083')
  assert.match(output.index.module_interface_digest, /^sha256:[0-9a-f]{64}$/)
  assert.match(output.index.index_revision, /^sha256:[0-9a-f]{64}$/)
  assert.equal(output.index.entries.length, 2)
  assert.ok(output.index.entries.every((entry) =>
    entry.graph_revision === output.index.graph_revision &&
    entry.index_revision === output.index.index_revision
  ))
  assert.notEqual(output.index.next_cursor, null)

  const unchanged = runCli(
    'review-index',
    '--changed-since',
    output.index.index_revision,
    'test/golden/canonical-hello.re',
  )
  assert.equal(unchanged.status, 0)
  assert.deepEqual(JSON.parse(unchanged.stdout).index.entries, [])
})

test('re review-index keeps failures inside the JSON protocol', () => {
  const badLimit = runCli('review-index', '--limit', '0', 'test/golden/canonical-hello.re')
  assert.equal(badLimit.status, 65)
  assert.equal(badLimit.stderr, '')
  assert.deepEqual(JSON.parse(badLimit.stdout), {
    diagnostics: [{ code: 'invalid-review-index-limit', limit: 0 }],
    file: 'test/golden/canonical-hello.re',
    ok: false,
    schema: 're.project-review-index-result@0.1.0',
  })

  const unreadable = runCli('review-index', 'test/fixtures/does-not-exist.re')
  assert.equal(unreadable.status, 65)
  assert.equal(unreadable.stderr, '')
  assert.deepEqual(JSON.parse(unreadable.stdout), {
    diagnostics: [{
      code: 'input-file-unreadable',
      column: 1,
      file: 'test/fixtures/does-not-exist.re',
      line: 1,
      reason: 'ENOENT',
    }],
    file: 'test/fixtures/does-not-exist.re',
    ok: false,
    schema: 're.project-review-index-result@0.1.0',
  })
})

test('re review-index expands one fact with revision and UID anchors', () => {
  const page = JSON.parse(runCli(
    'review-index',
    '--limit',
    '50',
    'test/golden/canonical-hello.re',
  ).stdout)
  const entry = page.index.entries.find(({ kind }) => kind === 'effect')
  assert.ok(entry)

  const expanded = runCli(
    'review-index',
    '--fact-id',
    entry.fact_id,
    '--index-revision',
    entry.index_revision,
    'test/golden/canonical-hello.re',
  )

  assert.equal(expanded.status, 0)
  assert.equal(expanded.stderr, '')
  assert.deepEqual(JSON.parse(expanded.stdout), {
    fact: {
      detail: {
        call_uid: entry.uid_anchor,
        kind: 'capability-member-call',
        member: 'write',
        parameter: 'data',
        parameter_endpoint: 'aaaaaaeaaaaaaaaaaaaaaaaaaa',
        schema_reference: 'process.stdout@0.1.0',
      },
      fact: entry,
      index_revision: entry.index_revision,
      schema: 're.project-review-fact@0.1.0',
    },
    file: 'test/golden/canonical-hello.re',
    ok: true,
    schema: 're.project-review-fact-result@0.1.0',
  })

  const stale = runCli(
    'review-index',
    '--fact-id',
    entry.fact_id,
    '--index-revision',
    `sha256:${'0'.repeat(64)}`,
    'test/golden/canonical-hello.re',
  )
  assert.equal(stale.status, 65)
  assert.equal(stale.stderr, '')
  assert.deepEqual(JSON.parse(stale.stdout), {
    diagnostics: [{
      actual: entry.index_revision,
      code: 'review-index-revision-mismatch',
      expected: `sha256:${'0'.repeat(64)}`,
    }],
    file: 'test/golden/canonical-hello.re',
    ok: false,
    schema: 're.project-review-fact-result@0.1.0',
  })

  const unknown = runCli(
    'review-index',
    '--fact-id',
    'fact:project/@hello/unknown',
    '--index-revision',
    entry.index_revision,
    'test/golden/canonical-hello.re',
  )
  assert.equal(unknown.status, 65)
  assert.equal(unknown.stderr, '')
  assert.deepEqual(JSON.parse(unknown.stdout).diagnostics, [{
    code: 'review-fact-not-found',
    fact_id: 'fact:project/@hello/unknown',
  }])

  const missingAnchor = runCli(
    'review-index',
    '--fact-id',
    entry.fact_id,
    'test/golden/canonical-hello.re',
  )
  assert.equal(missingAnchor.status, 65)
  assert.equal(missingAnchor.stderr, '')
  assert.deepEqual(JSON.parse(missingAnchor.stdout), {
    diagnostics: [{ code: 'review-fact-anchors-required' }],
    file: 'test/golden/canonical-hello.re',
    ok: false,
    schema: 're.project-review-fact-result@0.1.0',
  })
})

test('re profile emits a deterministic path-free benchmark descriptor', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-profile-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'renamed.re')
  await writeFile(
    file,
    await readFile(new URL('../test/golden/canonical-hello.re', import.meta.url), 'utf8'),
    'utf8',
  )

  const first = runCli('profile', file)
  const second = runCli('profile', file)

  assert.equal(first.status, 0)
  assert.equal(first.stderr, '')
  assert.equal(first.stdout, second.stdout)
  const output = JSON.parse(first.stdout)
  assert.equal(output.schema, 're.profile-result@0.1.0')
  assert.equal(output.file, file)
  assert.equal(output.ok, true)
  assert.equal(output.profile.schema, 're.profile-descriptor@0.1.0')
  assert.equal(output.profile.measurement_status, 'not-run')
  assert.equal(output.profile.target_profile, 'node-demo-self-contained-preview@0.1.0')
  assert.match(output.profile.benchmark_profile_digest, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(
    output.profile.candidates.map(({ id }) => id),
    ['aot-llvm', 'cranelift', 'go-lowering', 'jvm-bytecode', 'node-reference'],
  )
  assert.equal(Object.hasOwn(output.profile, 'backend'), false)
  assert.equal(Object.hasOwn(output.profile, 'eligibility'), false)
  assert.deepEqual(
    output.profile.workloads.map(({ id }) => id),
    [
      'cpu-pure-graph',
      'json-http',
      'db-transaction',
      'task-10k',
      'task-100k',
      'module-50-clean-incremental',
      'module-500-clean-incremental',
      'module-5000-clean-incremental',
    ],
  )
  assert.deepEqual(output.profile.runtime, {
    kind: 'self-contained-node-demo-runtime',
  })
  assert.equal(JSON.stringify(output.profile).includes(directory), false)
  assert.equal(JSON.stringify(output.profile).includes(file), false)
})

test('re profile is byte-identical for repeated compact input', async (context) => {
  const first = runCli('profile', 'examples/hello.re')
  const second = runCli('profile', 'examples/hello.re')

  assert.equal(first.status, 0)
  assert.equal(first.stderr, '')
  assert.equal(second.status, 0)
  assert.equal(second.stderr, '')
  assert.equal(first.stdout, second.stdout)

  const directory = await mkdtemp(join(tmpdir(), 're-profile-compact-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const renamed = join(directory, 'renamed.re')
  await writeFile(
    renamed,
    await readFile(new URL('../examples/hello.re', import.meta.url), 'utf8'),
    'utf8',
  )
  const moved = runCli('profile', renamed)
  assert.equal(moved.status, 0)
  assert.equal(
    JSON.parse(first.stdout).profile.benchmark_profile_digest,
    'sha256:df9b634c4571c4964b3b49198a36862300d95a39172e7cf8c833af6b691e0319',
  )
  assert.deepEqual(
    JSON.parse(moved.stdout).profile,
    JSON.parse(first.stdout).profile,
  )
})

test('re profile keeps source failures inside the JSON protocol', () => {
  const invalid = runCli('profile', 'test/fixtures/wrong-argument.re')
  assert.equal(invalid.status, 65)
  assert.equal(invalid.stderr, '')
  assert.equal(JSON.parse(invalid.stdout).schema, 're.profile-result@0.1.0')
  assert.equal(JSON.parse(invalid.stdout).ok, false)

  const unreadable = runCli('profile', 'test/fixtures/does-not-exist.re')
  assert.equal(unreadable.status, 65)
  assert.equal(unreadable.stderr, '')
  assert.deepEqual(JSON.parse(unreadable.stdout), {
    diagnostics: [{
      code: 'input-file-unreadable',
      column: 1,
      file: 'test/fixtures/does-not-exist.re',
      line: 1,
      reason: 'ENOENT',
    }],
    file: 'test/fixtures/does-not-exist.re',
    ok: false,
    schema: 're.profile-result@0.1.0',
  })
})

test('re check --write emits reusable canonical RE', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-canonical-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'hello.re')
  const compact = await readFile(
    new URL('../examples/hello.re', import.meta.url),
    'utf8',
  )
  await writeFile(file, compact, 'utf8')

  const written = runCli('check', '--write', file)

  assert.equal(written.status, 0)
  assert.equal(written.stdout, `WROTE ${file}\n`)
  assert.equal(written.stderr, '')
  const canonical = await readFile(file, 'utf8')
  assert.match(canonical, /^re 0\.1 canonical\n/)
  assert.match(canonical, /: uid\("[a-z2-7]{26}"\):/)

  const checked = runCli('check', file)
  assert.equal(checked.status, 0)
  assert.equal(checked.stdout, `OK ${file}\n`)
  assert.equal(checked.stderr, '')

  const executed = runCli('run', file)
  assert.equal(executed.status, 0)
  assert.equal(executed.stdout, 'Hello, World!\n')
  assert.equal(executed.stderr, '')
})

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

test('canonical diagnostics retain the real input file', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-canonical-error-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'broken.re')
  const compact = await readFile(
    new URL('../examples/hello.re', import.meta.url),
    'utf8',
  )
  await writeFile(file, compact, 'utf8')
  assert.equal(runCli('check', '--write', file).status, 0)
  const canonical = await readFile(file, 'utf8')
  await writeFile(
    file,
    canonical.replace(/(data: )%u[a-z2-7]{7}/, '$1%uzzzzzzz'),
    'utf8',
  )

  const result = runCli('check', file)

  assert.equal(result.status, 65)
  assert.ok(result.stderr.startsWith(`${file}:`))
  assert.match(result.stderr, /unknown-canonical-label/)
})

test('re patch atomically writes a revision-pinned patch and rejects stale replay', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-patch-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'hello.re')
  const patchFile = join(directory, 'replace-input.json')
  await writeFile(
    file,
    await readFile(new URL('../examples/hello.re', import.meta.url), 'utf8'),
    'utf8',
  )
  assert.equal(runCli('check', '--write', file).status, 0)
  const before = await readFile(file, 'utf8')
  const loaded = loadCanonicalGraph(before)
  assert.equal(loaded.ok, true)
  const returned = loaded.value.functions[0].statements.find(
    (statement) => statement.kind === 'return',
  )
  const errorExit = returned.value.branches.find((branch) => branch.variant === 'err').value
  const okExit = returned.value.branches.find((branch) => branch.variant === 'ok').value
  const patchDocument = {
    baseRevision: graphRevision(loaded.value),
    operations: [{
      callUid: errorExit.uid,
      expectedOldEndpoint: errorExit.arguments[0].source.endpoint,
      kind: 'replace-input',
      newEndpoint: okExit.arguments[0].source.endpoint,
      parameterName: 'code',
    }],
    schema: 're.structured-patch@0.1.0',
  }
  await writeFile(patchFile, `${JSON.stringify(patchDocument)}\n`, 'utf8')

  const applied = runCli('patch', '--patch', patchFile, file)

  assert.equal(applied.status, 0)
  assert.equal(applied.stderr, '')
  const result = JSON.parse(applied.stdout)
  assert.equal(result.schema, 're.patch-result@0.1.0')
  assert.equal(result.file, file)
  assert.equal(result.ok, true)
  assert.equal(result.receipt.base_revision, patchDocument.baseRevision)
  assert.equal(result.receipt.operations.length, 1)
  assert.notEqual(result.receipt.result_revision, patchDocument.baseRevision)
  const after = await readFile(file, 'utf8')
  assert.notEqual(after, before)
  assert.equal(runCli('check', file).status, 0)

  const replayed = runCli('patch', '--patch', patchFile, file)

  assert.equal(replayed.status, 65)
  assert.equal(replayed.stderr, '')
  const conflict = JSON.parse(replayed.stdout)
  assert.equal(conflict.ok, false)
  assert.equal(conflict.diagnostics.length, 1)
  assert.equal(conflict.diagnostics[0].code, 'patch-base-revision-mismatch')
  assert.equal(await readFile(file, 'utf8'), after)
})

test('re patch rejects compact input because it has no stable graph revision', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-patch-compact-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'hello.re')
  const patchFile = join(directory, 'replace-input.json')
  const compact = await readFile(
    new URL('../examples/hello.re', import.meta.url),
    'utf8',
  )
  await writeFile(file, compact, 'utf8')
  await writeFile(
    patchFile,
    `${JSON.stringify({
      baseRevision: `sha256:${'0'.repeat(64)}`,
      operations: [{
        callUid: 'a'.repeat(26),
        expectedOldEndpoint: `${'b'.repeat(25)}e`,
        kind: 'replace-input',
        newEndpoint: `${'c'.repeat(25)}i`,
        parameterName: 'data',
      }],
      schema: 're.structured-patch@0.1.0',
    })}\n`,
    'utf8',
  )

  const result = runCli('patch', '--patch', patchFile, file)

  assert.equal(result.status, 65)
  assert.equal(result.stderr, '')
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.diagnostics, [{ code: 'patch-requires-canonical-input' }])
  assert.equal(await readFile(file, 'utf8'), compact)
})

test('re module-surface binds an exact-pin surface through a versioned JSON contract', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-module-surface-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'api.re')
  const manifestFile = join(directory, 'manifest.json')
  const corpus = JSON.parse(await readFile(
    new URL('./fixtures/module-source-surface-corpus.json', import.meta.url),
    'utf8',
  ))
  const manifest = JSON.parse(await readFile(
    new URL('./fixtures/module-contract-corpus.json', import.meta.url),
    'utf8',
  ))
  await writeFile(file, corpus.cases[0].source, 'utf8')
  await writeFile(manifestFile, `${JSON.stringify(manifest.manifest)}\n`, 'utf8')

  const result = runCli('module-surface', '--manifest', manifestFile, file)

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), {
    file,
    manifest_file: manifestFile,
    module: {
      interface: manifest.manifest.modules
        .find(({ name }) => name === 'agent.relay.api').interface,
      interface_digest: 'sha256:5779705343e7f4562b4b006f2abfeadd3f24c2f164b0d2ed62a994fa94a1f240',
      module: 'agent.relay.api',
      package_manifest_digest: 'sha256:1f6486fe15e3d2dca2fe33185b62719c248fddf469263e26bf8cdc1f3837f61e',
      schema: 're.module-surface-lowering@0.1.0',
    },
    ok: true,
    schema: 're.module-surface-result@0.1.0',
  })
})

test('re project-check emits a path-free deterministic project graph envelope', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-project-check-'))
  context.after(async () => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'modules'))
  const source = [
    're 1.0 compact',
    'module agent.cli',
    'export serve',
    '',
  ].join('\n')
  const moduleInterface = {
    dependencies: [],
    exports: [{
      contract_digest: `sha256:${'a'.repeat(64)}`,
      kind: 'function',
      name: 'serve',
    }],
    module: 'agent.cli',
    schema: 're.module-interface@0.1.0',
  }
  const sourceSha = `sha256:${createHash('sha256').update(source).digest('hex')}`
  const packageManifest = {
    external_interfaces: [],
    modules: [{
      implementation_digest: sourceSha,
      interface: moduleInterface,
      interface_digest: moduleInterfaceDigest(moduleInterface),
      name: 'agent.cli',
    }],
    package: 'agent.cli',
    schema: 're.package-manifest@0.1.0',
  }
  await writeFile(join(directory, 'modules/main.re'), source)
  await writeFile(join(directory, 'project.json'), `${JSON.stringify({
    modules: [{
      name: 'agent.cli',
      path: 'modules/main.re',
      source_sha256: sourceSha,
    }],
    package_manifest: packageManifest,
    schema: 're.project-manifest@0.1.0',
  })}\n`)

  const result = runCli('project-check', '--format', 'json', directory)

  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout), {
    graph: {
      agents: [],
      graph_revision: JSON.parse(result.stdout).graph.graph_revision,
      modules: [{
        implementation_digest: sourceSha,
        interface_digest: moduleInterfaceDigest(moduleInterface),
        module_surface_digest: JSON.parse(result.stdout).graph.modules[0].module_surface_digest,
        name: 'agent.cli',
        relative_path: 'modules/main.re',
        source_sha256: sourceSha,
        surface: {
          interface: moduleInterface,
          interface_digest: moduleInterfaceDigest(moduleInterface),
          module: 'agent.cli',
          schema: 're.module-surface-lowering@0.1.0',
        },
      }],
      package_digest: packageManifestDigest(packageManifest),
      package_manifest: packageManifest,
      project_digest: JSON.parse(result.stdout).graph.project_digest,
      schema: 're.project-graph@0.1.0',
    },
    ok: true,
    schema: 're.project-check-result@0.1.0',
  })
})

test('re module-surface keeps manifest failures and stale pins fail closed in JSON', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-module-surface-negative-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'api.re')
  const manifestFile = join(directory, 'manifest.json')
  const corpus = JSON.parse(await readFile(
    new URL('./fixtures/module-source-surface-corpus.json', import.meta.url),
    'utf8',
  ))
  const manifest = JSON.parse(await readFile(
    new URL('./fixtures/module-contract-corpus.json', import.meta.url),
    'utf8',
  ))
  await writeFile(file, corpus.cases[5].source, 'utf8')
  await writeFile(manifestFile, '{not-json}\n', 'utf8')

  const invalidManifest = runCli('module-surface', '--manifest', manifestFile, file)

  assert.equal(invalidManifest.status, 65)
  assert.equal(invalidManifest.stderr, '')
  assert.deepEqual(JSON.parse(invalidManifest.stdout), {
    diagnostics: [{ code: 'manifest-json-invalid', manifest_file: manifestFile }],
    file,
    manifest_file: manifestFile,
    ok: false,
    schema: 're.module-surface-result@0.1.0',
  })

  await writeFile(manifestFile, `${JSON.stringify(manifest.manifest)}\n`, 'utf8')
  const stalePin = runCli('module-surface', '--manifest', manifestFile, file)
  assert.equal(stalePin.status, 65)
  assert.equal(stalePin.stderr, '')
  assert.equal(JSON.parse(stalePin.stdout).diagnostics[0].code, 'source-import-pin-mismatch')
})

test('re translate emits a deterministic execution artifact contract', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-translate-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const source = await readFile(
    new URL('../examples/hello.re', import.meta.url),
    'utf8',
  )
  const firstFile = join(directory, 'first.re')
  const secondFile = join(directory, 'second.re')
  await writeFile(firstFile, source, 'utf8')
  await writeFile(secondFile, source, 'utf8')

  const first = runCli('translate', '--format', 'json', firstFile)
  const second = runCli('translate', '--format', 'json', secondFile)

  assert.equal(first.status, 0)
  assert.equal(first.stderr, '')
  assert.equal(second.status, 0)
  const firstOutput = JSON.parse(first.stdout)
  const secondOutput = JSON.parse(second.stdout)
  assert.equal(firstOutput.schema, 're.translation-result@0.1.0')
  assert.equal(firstOutput.artifact.schema, 're.execution-artifact@0.1.0')
  assert.deepEqual(firstOutput.artifact, secondOutput.artifact)
  assert.equal(firstOutput.artifact.canonical.bytes.includes(directory), false)
  assert.equal(loadCanonicalGraph(firstOutput.artifact.canonical.bytes).ok, true)
})

test('re translate keeps source and input failures inside its JSON contract', () => {
  const invalid = runCli(
    'translate',
    '--format',
    'json',
    'test/fixtures/wrong-argument.re',
  )
  assert.equal(invalid.status, 65)
  assert.equal(invalid.stderr, '')
  assert.equal(JSON.parse(invalid.stdout).diagnostics[0].code, 'unexpected-argument')

  const unreadable = runCli(
    'translate',
    '--format',
    'json',
    'test/fixtures/does-not-exist.re',
  )
  assert.equal(unreadable.status, 65)
  assert.equal(unreadable.stderr, '')
  assert.deepEqual(JSON.parse(unreadable.stdout), {
    diagnostics: [{
      code: 'input-file-unreadable',
      column: 1,
      file: 'test/fixtures/does-not-exist.re',
      line: 1,
      reason: 'ENOENT',
    }],
    file: 'test/fixtures/does-not-exist.re',
    ok: false,
    schema: 're.translation-result@0.1.0',
  })
})

test('non-executable examples remain stable design fixtures', () => {
  const fixtures = [
    ['examples/cf-branch.re', 'match'],
    ['examples/cf-concurrent.re', 'user_id'],
    ['examples/cf-loop.re', 'loop'],
    ['examples/cf-retry.re', 'url'],
    ['examples/p0-demo-runtime.re', ':'],
    ['examples/schema-ops.re', 'op'],
  ]

  for (const [file, actual] of fixtures) {
    const result = runCli('check', file)

    assert.equal(result.status, 65, file)
    assert.equal(result.stdout, '', file)
    assert.match(result.stderr, new RegExp(`^${file}:\\d+:\\d+: unexpected-token`), file)
    assert.match(result.stderr, new RegExp(`got ${escapeRegExp(actual)}`), file)
    assert.match(result.stderr, /phase parse/, file)
    assert.match(result.stderr, /rule compact\.token-role/, file)
    assert.match(result.stderr, /repair replace/, file)
  }
})

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}
