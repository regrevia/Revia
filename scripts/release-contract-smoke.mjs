#!/usr/bin/env node
// The release contract: the one CLI behaviour every release surface must pass.
//
// Source builds, unpacked release binaries, downloaded launchers, the
// pre-publication gate, and the post-publication smoke all run this script with
// REVIA_EXECUTABLE pointing at the binary under test. Keeping the assertions in
// one portable place keeps those surfaces from drifting apart again: a workflow
// that asserts something the native CLI does not do fails here instead of during
// a publication attempt.
//
// Asserts, in order:
//   1. the binary reports a version, and a bare invocation does not succeed;
//   2. `check` returns a parser result envelope;
//   3. `manifest` returns a graph revision;
//   4. `compile` is byte-deterministic for the same source;
//   5. `run <graph> <artifact> <input-digest>` returns the execution receipt
//      with the program stdout, the expected outcome, the caller's input digest,
//      and byte-identical output across two runs;
//   6. usage errors exit 64 and unreadable input exits 66.
//
// Environment:
//   REVIA_EXECUTABLE     required, the release binary to exercise
//   REVIA_CONTRACT_ROOT  optional, directory holding examples/ (defaults to the
//                        repository root next to this script)
//
// Exit codes: 0 contract passed, 1 contract violated, 70 the binary or a
// fixture could not be executed.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.REVIA_CONTRACT_ROOT ?? join(SCRIPT_DIR, '..'));
const EXECUTABLE = process.env.REVIA_EXECUTABLE ?? '';
const INPUT_DIGEST = `sha256:${'d'.repeat(64)}`;
const PARSER_SCHEMA = 're.native-parser-result@0.1.0';
const EXECUTION_SCHEMA = 're.native-host-execution-result@0.1.0';

function abort(message, code = 70) {
  process.stderr.write(`release contract cannot run: ${message}\n`);
  process.exit(code);
}

if (!EXECUTABLE) {
  abort('REVIA_EXECUTABLE must name the release binary under test');
}
if (!existsSync(EXECUTABLE)) {
  abort(`executable not found: ${EXECUTABLE}`);
}

const work = mkdtempSync(join(tmpdir(), 'revia-release-contract-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

let lastRun = null;

function invoke(args) {
  const result = spawnSync(EXECUTABLE, args, {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  lastRun = { args, result };
  if (result.error) {
    abort(`cannot execute ${EXECUTABLE}: ${result.error.message}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function violated(message) {
  const lines = [`release contract failed: ${message}`];
  if (lastRun) {
    lines.push(`  command: ${EXECUTABLE} ${lastRun.args.join(' ')}`);
    lines.push(`  exit: ${lastRun.result.status}`);
    if (lastRun.result.stdout) lines.push(`  stdout: ${lastRun.result.stdout.trim()}`);
    if (lastRun.result.stderr) lines.push(`  stderr: ${lastRun.result.stderr.trim()}`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exit(1);
}

function expectStatus(wanted, args) {
  const run = invoke(args);
  if (run.status !== wanted) {
    violated(`expected exit ${wanted} from "${args.join(' ')}", got ${run.status}`);
  }
  return run;
}

function expectIncludes(haystack, needle, what) {
  if (!haystack.includes(needle)) {
    violated(`${what}: expected output to include ${JSON.stringify(needle)}`);
  }
}

const hello = join(ROOT, 'examples', 'hello.re');
const diagnostic = join(ROOT, 'examples', 'diagnostic-error.re');
for (const fixture of [hello, diagnostic]) {
  if (!existsSync(fixture)) {
    abort(`missing contract fixture: ${fixture}`);
  }
}

// 1. Version, and a bare invocation that must not report success.
const version = expectStatus(0, ['--version']);
if (version.stdout.trim() === '') {
  violated('--version printed nothing');
}
const bare = invoke([]);
if (bare.status === 0) {
  violated('invoking the binary with no arguments must not succeed');
}
expectIncludes(`${bare.stdout}${bare.stderr}`, 'Usage: revia', 'usage banner');

// 2. check returns a parser result envelope.
const check = expectStatus(0, ['check', hello]);
expectIncludes(check.stdout, `"schema":"${PARSER_SCHEMA}"`, 'check schema');
expectIncludes(check.stdout, '"ok":true', 'check ok flag');

// 3. manifest returns a graph revision.
const manifest = expectStatus(0, ['manifest', hello]);
expectIncludes(manifest.stdout, 'graph_revision', 'manifest graph revision');

// 4. compile is byte-deterministic for the same source.
const artifact = join(work, 'hello.artifact');
expectStatus(0, ['compile', hello, artifact]);
const firstArtifact = readFileSync(artifact);
expectStatus(0, ['compile', hello, artifact]);
if (!firstArtifact.equals(readFileSync(artifact))) {
  violated('compile is not byte-deterministic for the same source');
}

// 5. run consumes the compiled artifact and the caller's input digest.
const firstRun = expectStatus(0, ['run', hello, artifact, INPUT_DIGEST]);
expectIncludes(firstRun.stdout, `"schema":"${EXECUTION_SCHEMA}"`, 'run schema');
expectIncludes(firstRun.stdout, '"program_stdout":"Hello, World!\\n"', 'run program stdout');
expectIncludes(firstRun.stdout, '"outcome":{"code":0,"type":"process.status"}', 'run outcome');
expectIncludes(firstRun.stdout, `"input_digest":"${INPUT_DIGEST}"`, 'run input digest');
if (!/"receipt_digest":"sha256:[0-9a-f]{64}"/.test(firstRun.stdout)) {
  violated('run did not report a receipt digest');
}

const secondRun = expectStatus(0, ['run', hello, artifact, INPUT_DIGEST]);
if (secondRun.stdout !== firstRun.stdout) {
  violated('run output is not byte-identical across two runs');
}

// 6. Exit-code contract for usage and unreadable input.
const usage = expectStatus(64, ['check', hello, 'unexpected-argument']);
expectIncludes(`${usage.stdout}${usage.stderr}`, 'Usage: revia', 'usage error banner');
expectStatus(66, ['check', join(work, 'absent-input.re')]);

process.stdout.write('release contract passed\n');
