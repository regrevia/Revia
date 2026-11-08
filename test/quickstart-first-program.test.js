import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// The first-program section of QUICKSTART.md is executable documentation. This
// test runs the documented flow in a temporary directory and pins the output it
// promises, so the tutorial cannot drift away from the CLI. It also holds the
// native commands in README.md, README.zh-CN.md, QUICKSTART.md, and
// CONTRIBUTING.md to the order a fresh checkout needs: from `native/`, build
// the release binary before running the tests that execute it.

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

    // The tutorial ends the rejection by putting the call back, so a reader
    // learns that the verdict is about the edit and not about the file.
    await writeFile(join(scratch, 'broken.re'), first)
    const repaired = runCli(directory, 'check', 'scratch/broken.re')
    assert.equal(repaired.status, 0)
    assert.equal(repaired.stdout, 'OK scratch/broken.re\n')
    assert.equal(repaired.stderr, '')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('documented command exit codes match the CLI', async () => {
  // The tutorial separates the command's own exit codes from the code a
  // program chooses. Both halves are pinned to measured behaviour so a reader
  // can tell "my arguments are wrong" from "my program said so".
  const english = /The command's own exit code is[^\n]*(?:\n[^\n]+)*/u.exec(
    quickstart,
  )
  assert.ok(english !== null, 'QUICKSTART.md must name the exit codes')
  assert.match(english[0], /`0`[\s\S]*`64`[\s\S]*`65`/u)

  // The rejection section ends by repairing the edit; without that leg a
  // reader can copy a failing program and stop there.
  assert.ok(quickstart.includes('Put the call back'))
  assert.ok(quickstart.includes('把调用改回原样'))

  const chinese = /命令自身的退出码为[^\n]*(?:\n[^\n]+)*/u.exec(quickstart)
  assert.ok(chinese !== null, 'the Chinese quickstart must carry the sentence')
  assert.match(chinese[0], /`0`[\s\S]*`64`[\s\S]*`65`/u)

  const directory = await mkdtemp(join(tmpdir(), 'revia-exit-codes-'))
  try {
    const usage = runCli(directory)
    assert.equal(usage.status, 64)
    assert.equal(usage.stdout, '')
    assert.match(usage.stderr, /^Usage: re check /u)

    const missing = runCli(directory, 'check', 'scratch/missing.re')
    assert.equal(missing.status, 65)
    assert.equal(missing.stdout, '')
    assert.equal(
      missing.stderr,
      'scratch/missing.re: unable to read file (ENOENT)\n',
    )

    await mkdir(join(directory, 'scratch'), { recursive: true })
    await writeFile(
      join(directory, 'scratch', 'accepted.re'),
      await readFile(join(repositoryRoot, 'examples', 'hello.re'), 'utf8'),
    )
    const accepted = runCli(directory, 'check', 'scratch/accepted.re')
    assert.equal(accepted.status, 0)
    assert.equal(accepted.stdout, 'OK scratch/accepted.re\n')
    assert.equal(accepted.stderr, '')
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

const DOCUMENTED_NATIVE_FILES = [
  'README.md',
  'README.zh-CN.md',
  'QUICKSTART.md',
  'CONTRIBUTING.md',
]

test('documented native commands build the release binary before testing', async () => {
  const build = 'cargo build --workspace --release --offline'
  const tests = 'cargo test --workspace --offline'
  for (const file of DOCUMENTED_NATIVE_FILES) {
    const text = await readFile(join(repositoryRoot, file), 'utf8')
    const buildIndex = text.indexOf(build)
    const testIndex = text.indexOf(tests)
    assert.notEqual(buildIndex, -1, `${file} must document ${build}`)
    assert.notEqual(testIndex, -1, `${file} must document ${tests}`)
    assert.ok(
      buildIndex < testIndex,
      `${file} must document ${build} before ${tests}`,
    )
  }
  for (const file of ['README.md', 'README.zh-CN.md', 'QUICKSTART.md']) {
    const text = await readFile(join(repositoryRoot, file), 'utf8')
    assert.ok(
      text.slice(text.indexOf('cd native')).includes(build),
      `${file} must run the native commands from native/`,
    )
  }
})

const SECOND_PROGRAM = /cat > scratch\/read\.re <<'RE'\n([\s\S]*?)\nRE\n/u

test('the second-program tutorial runs as documented', async () => {
  const captured = SECOND_PROGRAM.exec(quickstart)
  assert.ok(
    captured !== null,
    'QUICKSTART.md must create scratch/read.re with a heredoc',
  )
  const program = captured[1]
  assert.match(program, /cap @files: fs\.read@0\.1\.0/u)
  assert.match(program, /@files\.read_file\(path: "input\.txt"\)/u)
  assert.match(
    quickstart,
    /Paths resolve relative to\s+the directory of the program file/u,
    'QUICKSTART.md must document where file paths resolve',
  )
  assert.ok(
    quickstart.includes('path: "../README.md"'),
    'QUICKSTART.md must name a path outside the sandbox',
  )

  const directory = await mkdtemp(join(tmpdir(), 'revia-second-program-'))
  try {
    const scratch = join(directory, 'scratch')
    await mkdir(scratch, { recursive: true })
    await writeFile(join(scratch, 'input.txt'), 'hello from input\n')
    await writeFile(join(scratch, 'read.re'), program)

    const check = runCli(directory, 'check', 'scratch/read.re')
    assert.equal(check.status, 0)
    assert.equal(check.stdout, 'OK scratch/read.re\n')
    assert.equal(check.stderr, '')

    const run = runCli(directory, 'run', 'scratch/read.re')
    assert.equal(run.status, 0)
    assert.equal(run.stdout, '')
    assert.equal(run.stderr, '')

    // The program's own directory is the sandbox: a path that leaves it still
    // passes `check` and takes the error branch at run time instead.
    const outside = program.replace('"input.txt"', '"../README.md"')
    await writeFile(join(scratch, 'read-outside.re'), outside)
    const outsideCheck = runCli(directory, 'check', 'scratch/read-outside.re')
    assert.equal(outsideCheck.status, 0)
    assert.equal(outsideCheck.stdout, 'OK scratch/read-outside.re\n')
    const outsideRun = runCli(directory, 'run', 'scratch/read-outside.re')
    assert.equal(outsideRun.status, 3)
    assert.equal(outsideRun.stdout, '')
    assert.equal(outsideRun.stderr, '')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const DESIGN_DOCS = ['doc', 'docs']

// Every code fence in the design documents that opens with the program header is
// classified by running it, not by reading the surrounding prose. One document
// ships a runnable sample; the rest are historical or illustrative shapes and
// carry a note that says so, so a reader cannot copy them as working code.
test('design documents separate runnable samples from illustrations', async () => {
  const fence = /```[^\n]*\n([\s\S]*?)```/gu
  const programs = []
  for (const directory of DESIGN_DOCS) {
    const names = (await readdir(join(repositoryRoot, directory))).sort()
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const file = `${directory}/${name}`
      if (file.startsWith('docs/') && !/^docs\/language[^/]*\.md$/u.test(file)) {
        continue
      }
      const text = await readFile(join(repositoryRoot, file), 'utf8')
      for (const match of text.matchAll(fence)) {
        if (match[1].startsWith('re 0.1 compact')) {
          programs.push({ body: match[1], file })
        }
      }
    }
  }
  assert.ok(programs.length > 0, 'the design documents must embed samples')

  const directory = await mkdtemp(join(tmpdir(), 'revia-design-samples-'))
  try {
    const runnable = []
    const rejected = []
    for (const [index, program] of programs.entries()) {
      const path = join(directory, `sample-${index}.re`)
      await writeFile(path, program.body)
      const check = runCli(directory, 'check', path)
      if (check.status === 0) {
        runnable.push(program.file)
      } else {
        assert.equal(check.status, 65, `${program.file} must be rejected with 65`)
        rejected.push(program.file)
      }
    }
    assert.deepEqual(runnable, ['docs/language.md'])
    assert.deepEqual(rejected, [
      'doc/00-overview.md',
      'doc/00-overview.md',
      'doc/01-syntax.md',
    ])

    for (const file of ['doc/00-overview.md', 'doc/01-syntax.md']) {
      const text = await readFile(join(repositoryRoot, file), 'utf8')
      assert.ok(
        /不是当前工具链可执行的程序|不是可执行样例/u.test(text),
        `${file} must say its samples are not runnable`,
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
