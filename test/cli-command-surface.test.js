import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const corpus = JSON.parse(await readFile(
  new URL('./fixtures/cli-command-surface.json', import.meta.url),
  'utf8',
))

test('launcher surfaces match the shared CLI command-surface corpus', async () => {
  const sh = await readFile(new URL('../bin/revia', import.meta.url), 'utf8')
  const powershell = await readFile(new URL('../bin/revia.ps1', import.meta.url), 'utf8')
  const windowsWorkflow = await readFile(
    new URL('../.github/workflows/windows-native.yml', import.meta.url),
    'utf8',
  )
  const powershellContract = await readFile(
    new URL('../scripts/test-cli-surface.ps1', import.meta.url),
    'utf8',
  )
  const version = (await readFile(new URL('../VERSION', import.meta.url), 'utf8')).trim()

  assert.equal(corpus.schema, 're.cli-command-surface-corpus@0.1.0')
  assert.equal(corpus.historical_native_version, version)
  assert.equal(corpus.native_run_arity, 3)
  assert.ok(sh.includes(`[ "$VERSION" = '${version}' ]`))
  assert.ok(powershell.includes(`$Version -cne '${version}'`))
  assert.doesNotMatch(powershell, /\s-(?:in|cin|notin|cnotin)\b/u)
  for (const command of corpus.reference_only_commands) {
    assert.match(sh, new RegExp(`\\b${command}\\b`, 'u'))
    assert.match(powershell, new RegExp(`\\b${command}\\b`, 'u'))
  }
  assert.match(sh, /source-form invocation/u)
  assert.match(powershell, /source-form invocation/u)
  assert.doesNotMatch(powershellContract, /,\s*@\(/u)
  assert.doesNotMatch(powershell, /(?:-and|-or)\s*@\(/u)
  assert.match(windowsWorkflow, /scripts\/test-cli-surface\.ps1/u)
  assert.match(powershellContract, /Node reference only/u)
})

test('Bash launcher help identifies both interfaces without downloading', async (context) => {
  const fixture = await createLauncherFixture(context, { cachedNative: true })

  for (const args of [
    ['--help'],
    ['help'],
    ['help', 'run'],
    ['help', 'view'],
    ['help', 'build'],
    ['help', 'project-translate'],
    ['view', '--help'],
  ]) {
    const result = runBashLauncher(fixture, args)
    assert.equal(result.status, 0, args.join(' '))
    if (args[0] === 'help' && args[1] === 'run') {
      assert.match(result.stdout, /Native:/u)
      assert.match(result.stdout, /Reference:/u)
    } else if (args[0] === 'help' && args[1] === 'project-translate') {
      assert.match(result.stdout, /Native: revia project-translate/u)
      assert.match(result.stdout, /Reference: npm run re -- project-translate/u)
    } else if ((args[0] === 'help' && args[1] === 'view')
      || (args[0] === 'view' && args[1] === '--help')) {
      assert.match(result.stdout, /Node reference only/u)
    } else if (args[0] === 'help' && args[1]) {
      assert.match(result.stdout, /Node reference only/u)
    } else {
      assert.match(result.stdout, /native release CLI/u)
      assert.match(result.stdout, /npm run re --/u)
    }
    assert.equal(result.stderr, '')
  }
  for (const args of [['help', 'lex'], ['lex', '--help']]) {
    const result = runBashLauncher(fixture, args)
    assert.equal(result.status, 0, args.join(' '))
    assert.deepEqual(result.stdout.trimEnd().split('\n'), args)
    assert.equal(result.stderr, '')
  }
  for (const args of [['help', 'check', 'extra'], ['help', 'a', 'b']]) {
    const result = runBashLauncher(fixture, args)
    assert.equal(result.status, 64, args.join(' '))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Usage: revia help <command>/u)
  }
  assert.equal(await markerCalled(fixture), false)
})

test('Bash launcher routes only Node source-form shapes before network access', async (context) => {
  const fixture = await createLauncherFixture(context)
  const absoluteSource = join(fixture.root, 'examples', 'hello.re')
  await mkdir(join(fixture.root, 'examples'), { recursive: true })
  await writeFile(absoluteSource, 'source fixture\n')
  const cases = [
    ...corpus.source_form.map(({ args, id }) => [id, args]),
    ['run-absolute', ['run', absoluteSource]],
  ]

  for (const [id, args] of cases) {
    const result = runBashLauncher(fixture, args)
    assert.equal(result.status, 64, `${id}: ${result.stderr}`)
    assert.equal(result.stdout, '', id)
    assert.match(result.stderr, /npm run re --/u, id)
    assert.doesNotMatch(result.stderr, /Downloading Revia/u, id)
  }
  assert.equal(await markerCalled(fixture), false)
})

test('Bash launcher passes native commands through without guessing from .re paths', async (context) => {
  const fixture = await createLauncherFixture(context, { cachedNative: true })
  const nativeThreeOperand = [
    'run',
    join(fixture.root, 'graph.re'),
    join(fixture.root, 'program.bytecode'),
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]
  const nativeSourceOneShot = [
    'execute',
    join(fixture.root, 'graph.re'),
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]
  const nativeSeparatorPath = [
    'run',
    join(fixture.root, 'graph.re'),
    '--',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]
  const nativeFlagLikePath = [
    'run',
    '--',
    join(fixture.root, 'artifact'),
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]
  const incompleteNative = ['run', 'graph', 'artifact']
  const emptyReferenceSeparator = ['run', 'examples/hello.re', '--']

  for (const args of [
    ...corpus.native_controls.map(({ args }) => args),
    nativeThreeOperand,
    ['run', '--authority-pin', 'pin.json', 'examples/hello.re'],
    nativeSeparatorPath,
    nativeFlagLikePath,
    ['run', '--format', 'json', 'examples/hello.re'],
    ['run', 'examples/hello.re', '--', 'one'],
    ['check', '--format'],
    ['check', '--write', 'notes.txt'],
    ['translate', 'examples/hello.re'],
    nativeSourceOneShot,
    incompleteNative,
    emptyReferenceSeparator,
    ['project-translate', 'project', 'cache', 'build', 'profile', 'toolchain', 'module'],
    ['project-translate', 'project', 'cache', 'build'],
    ['project-check', '--format', 'json', 'project', 'extra'],
    ['project-run', '--fixture', 'fixture.json', 'project', 'extra'],
    ['RUN', 'examples/hello.re'],
    ['VIEW', 'examples/hello.re'],
    ['run', '--FORMAT', 'json', 'examples/hello.re'],
    ['project-translate', '--locale', 'en-us', 'project'],
  ]) {
    const result = runBashLauncher(fixture, args)
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    assert.deepEqual(result.stdout.trimEnd().split('\n'), args)
  }
  assert.equal(await markerCalled(fixture), false)
})

test('Node reference run and view source forms execute successfully', () => {
  const run = spawnSync('npm', [
    'run',
    're',
    '--',
    'run',
    'examples/agent-review/main.re',
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /agent=ready/u)

  const view = spawnSync('npm', [
    'run',
    're',
    '--',
    'view',
    '--format',
    'html',
    'examples/agent-review/main.re',
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(view.status, 0, view.stderr)
  assert.match(view.stdout, /<!doctype html>/iu)
})

test('silent npm reference output remains machine-readable under redirection', () => {
  const result = spawnSync('npm', [
    'run',
    '--silent',
    're',
    '--',
    'manifest',
    'examples/agent-review/main.re',
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /^>\s/mu)
  assert.equal(JSON.parse(result.stdout).file, 'examples/agent-review/main.re')
})

async function createLauncherFixture(context, { cachedNative = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'revia-cli-surface-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const launcherRoot = join(directory, 'project')
  const bin = join(launcherRoot, 'bin')
  const runtime = join(launcherRoot, 'runtime')
  const tools = join(directory, 'tools')
  const cache = join(directory, 'cache')
  const marker = join(directory, 'curl-called')
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(runtime, { recursive: true }),
    mkdir(tools, { recursive: true }),
  ])
  await copyFile(join(root, 'bin/revia'), join(bin, 'revia'))
  await writeFile(join(launcherRoot, 'VERSION'), `${corpus.historical_native_version}\n`)

  const platform = currentNativePlatform()
  const archive = `revia-${corpus.historical_native_version}-${platform}.tar.gz`
  const binary = `revia-${corpus.historical_native_version}-${platform}`
  const executable = Buffer.from(
    '#!/bin/sh\nprintf "%s\\n" "$@"\n',
    'utf8',
  )
  const executableDigest = createHash('sha256').update(executable).digest('hex')
  const checksums = [
    `${'a'.repeat(64)}  ${archive}`,
    `${executableDigest}  ${binary}`,
  ].join('\n') + '\n'
  await writeFile(join(runtime, 'checksums.txt'), checksums)

  const curl = join(tools, 'curl')
  await writeFile(curl, '#!/bin/sh\n: > "$REVIA_CURL_MARKER"\nexit 99\n')
  await chmod(curl, 0o755)

  if (cachedNative) {
    const cached = join(cache, 'revia', corpus.historical_native_version, platform)
    await mkdir(cached, { recursive: true })
    await writeFile(join(cached, 'revia'), executable)
    await chmod(join(cached, 'revia'), 0o755)
  }
  return {
    cache,
    launcher: join(bin, 'revia'),
    marker,
    root: launcherRoot,
    tools,
  }
}

function runBashLauncher(fixture, args) {
  return spawnSync('sh', [fixture.launcher, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.tools}:${process.env.PATH ?? ''}`,
      REVIA_CURL_MARKER: fixture.marker,
      XDG_CACHE_HOME: fixture.cache,
    },
  })
}

async function markerCalled(fixture) {
  try {
    await readFile(fixture.marker)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function currentNativePlatform() {
  const os = process.platform === 'darwin'
    ? 'darwin'
    : process.platform === 'linux'
      ? 'linux'
      : null
  assert.ok(os, `unsupported test host ${process.platform}`)
  const architecture = process.arch === 'arm64'
    ? 'arm64'
    : process.arch === 'x64'
      ? 'x64'
      : null
  assert.ok(architecture, `unsupported test architecture ${process.arch}`)
  return `${os}-${architecture}`
}
