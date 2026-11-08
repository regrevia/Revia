import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// The first-program section of QUICKSTART.md is executable documentation. This
// test runs the documented flow in a temporary directory and pins the output it
// promises, so the tutorial cannot drift away from the CLI.

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const cli = join(repositoryRoot, 'src', 'cli', 're.js')
const quickstart = await readFile(join(repositoryRoot, 'QUICKSTART.md'), 'utf8')

const DOCUMENTED_COMMANDS = [
  'npm run re -- run scratch/first.re',
  'npm run re -- check scratch/first.re',
  'npm run re -- check --format json scratch/first.re',
  'npm run re -- manifest scratch/first.re',
]

function runCli(cwd, ...arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd,
    encoding: 'utf8',
  })
}

test('the first-program tutorial runs as documented', async () => {
  for (const command of DOCUMENTED_COMMANDS) {
    assert.ok(
      quickstart.includes(command),
      `QUICKSTART.md must document ${command}`,
    )
  }
  assert.match(
    quickstart,
    /scratch\/first\.re:9:28: unexpected-argument \(expected data, got message\)/u,
    'QUICKSTART.md must quote the measured diagnostic',
  )

  const directory = await mkdtemp(join(tmpdir(), 'revia-first-program-'))
  try {
    const hello = await readFile(join(repositoryRoot, 'examples', 'hello.re'), 'utf8')
    assert.equal(
      hello.split('"Hello, World!\\n"').length,
      2,
      'examples/hello.re must carry exactly one Hello, World! literal',
    )
    const first = hello.replace('"Hello, World!\\n"', '"Hello, Revia!\\n"')
    const scratch = join(directory, 'scratch')
    await mkdir(scratch, { recursive: true })
    await writeFile(join(scratch, 'first.re'), first)

    const run = runCli(directory, 'run', 'scratch/first.re')
    assert.equal(run.status, 0)
    assert.equal(run.stdout, 'Hello, Revia!\n')
    assert.equal(run.stderr, '')

    const check = runCli(directory, 'check', 'scratch/first.re')
    assert.equal(check.status, 0)
    assert.equal(check.stdout, 'OK scratch/first.re\n')
    assert.equal(check.stderr, '')

    const json = runCli(directory, 'check', '--format', 'json', 'scratch/first.re')
    assert.equal(json.status, 0)
    assert.deepEqual(JSON.parse(json.stdout), {
      diagnostics: [],
      file: 'scratch/first.re',
      ok: true,
      schema: 're.check-result@0.1.0',
    })
    assert.equal(json.stderr, '')

    const manifest = runCli(directory, 'manifest', 'scratch/first.re')
    assert.equal(manifest.status, 0)
    const manifestResult = JSON.parse(manifest.stdout)
    assert.equal(manifestResult.schema, 're.review-manifest@0.1.0')
    assert.equal(manifestResult.ok, true)
    assert.equal(
      manifestResult.manifest.capabilities[0].reference,
      'process.stdout@0.1.0',
    )
    assert.equal(manifest.stderr, '')

    await writeFile(
      join(scratch, 'broken.re'),
      first.replace(
        '@stdout.write("Hello, Revia!\\n")',
        '@stdout.write(message: "Hello, Revia!\\n")',
      ),
    )
    const broken = runCli(directory, 'check', 'scratch/broken.re')
    assert.equal(broken.status, 65)
    assert.equal(broken.stdout, '')
    assert.equal(
      broken.stderr,
      'scratch/broken.re:9:28: unexpected-argument (expected data, got message)\n',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the native first-run block builds the release binary before testing', () => {
  // A fresh clone has no native/target, and wp283_release_evidence_cli panics
  // unless native/target/release/revia exists, so the build must come first.
  const build = quickstart.indexOf('cargo build --workspace --release --offline')
  const tests = quickstart.indexOf('cargo test --workspace --offline')
  assert.notEqual(build, -1, 'QUICKSTART.md must document the release build')
  assert.notEqual(tests, -1, 'QUICKSTART.md must document the native tests')
  assert.ok(
    build < tests,
    'the release build must be documented before cargo test',
  )
})
