#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPublicPreview } from './build-public-preview.js'
import {
  commitPortableConformanceEvidence,
} from './portable-conformance-evidence-store.js'
import { verifyPublicPreviewCandidate } from './verify-public-preview-candidate.js'
import { digestTrackedFiles } from '../src/runtime/release-evidence.js'
import { RELEASE_TOOLCHAIN_PATHS } from '../src/runtime/release-toolchain-inventory.js'
import {
  runGrammarFuzzGate,
  verifyGrammarFuzzBaseline,
} from '../src/toolchain/grammar-fuzz-gate.js'
import {
  createPortableConformanceRunReceipt,
  mergePortableConformanceRunReceipt,
  validatePortableConformanceMatrix,
} from '../src/toolchain/portable-conformance-matrix.js'
import {
  runPortableConformanceBundle,
} from '../src/toolchain/portable-conformance.js'
import { checkSource } from '../src/toolchain/demo-toolchain.js'
import { selectTrackedTests } from '../src/toolchain/tracked-test-runner.js'

const ROOT = new URL('../', import.meta.url)
const ROOT_PATH = ROOT.pathname
const MATRIX_PATH = new URL(
  '../release/portable-conformance-matrix.json',
  import.meta.url,
)
const EVIDENCE_PATH = new URL(
  '../release/portable-conformance-matrix-evidence.json',
  import.meta.url,
)
const CANDIDATE_PATH = new URL(
  '../public-preview/release-candidate.json',
  import.meta.url,
)
const BASELINE_PATH = new URL(
  '../test/fixtures/grammar-fuzz-baseline.json',
  import.meta.url,
)
const RELEASE_LOCK_PATH = new URL(
  '../release/agent-project-release-lock.json',
  import.meta.url,
)
try {
  const matrix = await readJson(MATRIX_PATH)
  const validated = validatePortableConformanceMatrix(matrix)
  if (!validated.ok) fail(validated.diagnostics[0].code)

  const bundle = await readJson(new URL(`../${matrix.bundle_path}`, import.meta.url))
  if (canonicalDigest(bundle) !== matrix.bundle_digest) {
    fail('portable-conformance-bundle-digest-mismatch')
  }
  const releaseLock = await readJson(RELEASE_LOCK_PATH)
  const actualToolchainDigest = digestTrackedFiles(
    await trackedEntries(RELEASE_TOOLCHAIN_PATHS),
  )
  if (releaseLock?.toolchain?.digest !== matrix.toolchain_digest
    || actualToolchainDigest !== matrix.toolchain_digest) {
    fail('portable-conformance-toolchain-digest-mismatch')
  }
  const portableResult = await runPortableConformanceBundle(bundle, {
    loadGraph: async (entry) => {
      const source = await readFile(new URL(`../${entry.graph}`, import.meta.url), 'utf8')
      const checked = checkSource(source, { file: entry.graph })
      if (!checked.ok) fail(checked.diagnostics[0].code)
      return { ...checked.program, graph_revision: entry.graph_revision }
    },
  })
  if (!portableResult.ok) fail(portableResult.diagnostics[0].code)

  const trackedTests = selectTrackedTests({ cwd: ROOT_PATH })
  if (trackedTests.length
      !== matrix.authorities.tracked_tests.selected_test_count
    || canonicalDigest(trackedTests)
      !== matrix.authorities.tracked_tests.selected_tests_digest) {
    fail('portable-conformance-tracked-tests-digest-mismatch')
  }

  const baseline = await readJson(BASELINE_PATH)
  const fuzz = await runGrammarFuzzGate({
    iterations: matrix.authorities.grammar_fuzz.iterations,
  })
  const baselineMatch = verifyGrammarFuzzBaseline(fuzz, baseline)
  if (!fuzz.ok || !baselineMatch) {
    fail('portable-conformance-grammar-fuzz-failed')
  }

  const tree = await mkdtemp(join(tmpdir(), 'revia-portable-matrix-'))
  let candidateResult
  try {
    await buildPublicPreview({ outDir: tree })
    candidateResult = await verifyPublicPreviewCandidate({
      candidatePath: CANDIDATE_PATH.pathname,
      treeRoot: tree,
    })
  } finally {
    await rm(tree, { force: true, recursive: true })
  }

  const receipt = createPortableConformanceRunReceipt({
    environment: {
      architecture: process.arch,
      id: `${process.platform}-${process.arch}-node-${nodeMajor()}`,
      node_major: nodeMajor(),
      node_version: process.version,
      platform: process.platform,
    },
    grammarFuzz: {
      baseline_match: baselineMatch,
      crash_count: fuzz.crash_count,
      iterations: fuzz.iterations,
      near_linear: fuzz.near_linear,
      nondeterministic_count: fuzz.nondeterministic_count,
      report_digest: fuzz.outcome_digest,
      wrong_graph_count: fuzz.wrong_graph_count,
    },
    matrix,
    portable: {
      case_count: portableResult.value.cases.length,
      result_digest: canonicalDigest(portableResult.value),
    },
    publicCandidate: {
      file_count: candidateResult.file_count,
      tree_digest: candidateResult.tree_digest,
      verified: candidateResult.ok,
    },
    trackedTests: {
      selected_test_count: trackedTests.length,
      selected_tests_digest: canonicalDigest(trackedTests),
      status: 0,
    },
  })
  if (!receipt.ok) fail(receipt.diagnostics[0].code)
  const existingEvidence = await readJson(EVIDENCE_PATH)
  const evidence = mergePortableConformanceRunReceipt({
    evidence: existingEvidence,
    matrix,
    receipt: receipt.value,
  })
  if (!evidence.ok) fail(evidence.diagnostics[0].code)
  await commitPortableConformanceEvidence({
    destination: EVIDENCE_PATH.pathname,
    evidence: evidence.value,
    verify: async (temporaryEvidencePath) => {
      const testRun = spawnSync(process.execPath, [
        '--test',
        '--experimental-test-isolation=none',
        ...trackedTests,
      ], {
        cwd: ROOT_PATH,
        env: {
          ...process.env,
          RE_PORTABLE_CONFORMANCE_EVIDENCE_PATH: temporaryEvidencePath,
        },
        shell: false,
        stdio: 'inherit',
      })
      if (testRun.error !== undefined || testRun.status !== 0) {
        fail('portable-conformance-tracked-tests-failed')
      }
    },
  })
  process.stdout.write(`${JSON.stringify({
    environment: receipt.value.environment.id,
    evidence_digest: evidence.value.evidence_digest,
    pending_environments: evidence.value.pending_environments,
    receipt_digest: receipt.value.receipt_digest,
    schema: evidence.value.schema,
    status: evidence.value.status,
  })}\n`)
} catch (error) {
  process.stderr.write(
    `${error?.code ?? error?.message ?? 'portable-conformance-matrix-failed'}\n`,
  )
  process.exitCode = 1
}

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'))
}

async function trackedEntries(paths) {
  return Promise.all(paths.map(async (path) => ({
    bytes: await readFile(new URL(`../${path}`, import.meta.url)),
    path,
  })))
}

function nodeMajor() {
  return Number(process.versions.node.split('.')[0])
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
