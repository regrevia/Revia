// Guards the release contract against drift.
//
// The pre-publication gate used to assert CLI behaviour the native binary never
// had (`check --format json`, a single-argument `run`) and to call helper
// scripts written for the retired Node CLI. Those assertions could only be
// discovered by attempting a publication. This test keeps one portable contract
// script as the single source of truth and fails when a workflow reintroduces a
// shape the binary does not implement.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = join(ROOT, 'scripts', 'release-contract-smoke.mjs');
const GATE = readFileSync(join(ROOT, '.github', 'workflows', 'release-gate.yml'), 'utf8');
const SMOKE = readFileSync(join(ROOT, '.github', 'workflows', 'release-smoke.yml'), 'utf8');
const POSIX = process.platform !== 'win32';

function makeStub(body) {
  const dir = mkdtempSync(join(tmpdir(), 'revia-contract-stub-'));
  const stub = join(dir, 'revia-stub.sh');
  writeFileSync(
    stub,
    `#!/bin/sh\nset -eu\nout() { printf '%s\\n' "$1"; }\n${body}\n`,
    'utf8',
  );
  chmodSync(stub, 0o755);
  return { dir, stub };
}

const HONEST_STUB = `
case "\${1:-}" in
  --version) out 'revia 0.0.0-test'; exit 0 ;;
  '') printf 'Usage: revia <check|compile|run>\\n' >&2; exit 64 ;;
esac
case "$1" in
  check)
    if [ "\${3:-}" = 'unexpected-argument' ]; then
      printf 'Usage: revia <check|compile|run>\\n' >&2
      exit 64
    fi
    if [ ! -f "$2" ]; then exit 66; fi
    out '{"schema":"re.native-parser-result@0.1.0","ok":true}'
    ;;
  manifest)
    out '{"graph_revision":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}'
    ;;
  compile)
    printf 'artifact-bytes' > "$3"
    ;;
  run)
    out '{"schema":"re.native-host-execution-result@0.1.0","ok":true,"program_stdout":"Hello, World!\\n","input_digest":"'"$4"'","outcome":{"code":0,"type":"process.status"},"receipt_digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}'
    ;;
  *) exit 65 ;;
esac
`;

test('the gate delegates its binary assertions to the shared release contract', () => {
  const invocations = GATE.match(/node (?:scripts|contract)\/release-contract-smoke\.mjs/g) ?? [];
  assert.ok(
    invocations.length >= 4,
    `release-gate.yml must run the shared contract on every release surface, found ${invocations.length}`,
  );
  // POSIX draft asset, Windows draft asset, self-hosted Windows asset use the
  // checked-out script; the published-asset job has no checkout, so it fetches
  // the script from the tag it is verifying.
  assert.match(GATE, /node scripts\/release-contract-smoke\.mjs/);
  assert.match(GATE, /\$raw\/scripts\/release-contract-smoke\.mjs/);
  // POSIX draft asset, Windows draft asset, self-hosted Windows asset, published asset.
  assert.match(GATE, /REVIA_CONTRACT_ROOT="\$PWD\/public-assets"/);
});

test('neither workflow asserts a CLI shape the native binary does not have', () => {
  for (const [name, workflow] of [['release-gate.yml', GATE], ['release-smoke.yml', SMOKE]]) {
    assert.ok(!workflow.includes('--format json'), `${name} still passes --format json to check`);
    assert.ok(
      !/revia(?:\.exe|\.ps1)?\s+run\s+[^\n]*\.re\s*\)/.test(workflow),
      `${name} still calls run with a single argument`,
    );
    assert.ok(!workflow.includes('re.native-review-manifest@0.1.0'), `${name} asserts a retired schema`);
  }
});

test('the gate no longer calls the retired Node CLI helper scripts', () => {
  for (const script of ['test-json-contract.sh', 'test-compact-determinism.sh', 'test-compact-determinism.ps1']) {
    assert.ok(!GATE.includes(script), `release-gate.yml still calls ${script}`);
  }
});

test('the contract asserts the parsed, compiled, and executed shapes', () => {
  const contract = readFileSync(CONTRACT, 'utf8');
  for (const fragment of [
    're.native-parser-result@0.1.0',
    're.native-host-execution-result@0.1.0',
    'graph_revision',
    'program_stdout',
    'receipt_digest',
    'compile is not byte-deterministic',
    'expectStatus(64',
    'expectStatus(66',
  ]) {
    assert.ok(contract.includes(fragment), `contract is missing the ${fragment} assertion`);
  }
  assert.ok(existsSync(CONTRACT));
});

test('the contract passes a binary that honours the contract', { skip: !POSIX }, () => {
  const { dir, stub } = makeStub(HONEST_STUB);
  try {
    const result = spawnSync(process.execPath, [CONTRACT], {
      encoding: 'utf8',
      env: { ...process.env, REVIA_EXECUTABLE: stub },
    });
    assert.equal(result.status, 0, `contract rejected a conforming binary:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /release contract passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the contract rejects a binary whose stdout drifts', { skip: !POSIX }, () => {
  const { dir, stub } = makeStub(HONEST_STUB.replace('Hello, World!', 'Goodbye, World!'));
  try {
    const result = spawnSync(process.execPath, [CONTRACT], {
      encoding: 'utf8',
      env: { ...process.env, REVIA_EXECUTABLE: stub },
    });
    assert.notEqual(result.status, 0, 'contract accepted a binary with the wrong program stdout');
    assert.match(result.stderr, /program stdout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the contract refuses to guess when no binary is named', { skip: !POSIX }, () => {
  const home = mkdtempSync(join(tmpdir(), 'revia-contract-empty-'));
  try {
    const result = spawnSync(process.execPath, [CONTRACT], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home },
    });
    assert.equal(result.status, 70);
    assert.match(result.stderr, /REVIA_EXECUTABLE/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
