import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// The files this repository publishes: the five source roots plus the
// explicit paths below. `--refresh` rebuilds the allowlist from exactly this
// selection, so a file that is admitted once but reachable from neither the
// roots nor this list would be silently dropped on the next refresh.
const SOURCE_ROOTS = [
  'doc',
  'native',
  'src',
  'test',
  'test-support',
]

const EXPLICIT_PATHS = [
  '.gitattributes',
  '.gitignore',
  '.github/workflows/validate.yml',
  'AGENTS.md',
  'bin/revia',
  'bin/revia.ps1',
  'CONTRIBUTING.md',
  'docs/README.md',
  'examples/README.md',
  'experiments/README.md',
  'LICENSE',
  'LICENSE-PREVIEW-0.1.md',
  'NOTICE.md',
  'NOTICE-PREVIEW-0.1.md',
  'QUICKSTART.md',
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'SOURCE-LICENSE.md',
  'package.json',
  'projects/README.md',
  'examples/agent-expense-review-run.json',
  'examples/agent-expense-review',
  'examples/args-check.re',
  'examples/cf-branch.re',
  'examples/cf-concurrent.re',
  'examples/cf-loop.re',
  'examples/cf-retry.re',
  'examples/p0-demo-runtime.re',
  'examples/read-check.re',
  'examples/read-encoding.re',
  'examples/schema-ops.re',
  'examples/write-check.re',
  'scripts/build-source-import-manifest.js',
  'scripts/run-agent-authoring-loop-conformance.js',
  'scripts/run-agent-project-benchmark.js',
  'scripts/run-agent-writing-evaluation.js',
  'scripts/run-backend-feasibility.js',
  'scripts/run-external-runner.js',
  'scripts/run-human-semantic-review-conformance.js',
  'scripts/run-llvm-aot-external-evidence.js',
  'scripts/run-minimal-std-abi.js',
  'scripts/run-minimal-std-cache.js',
  'scripts/run-minimal-std-native-runner.js',
  'scripts/run-module-artifact-cache-benchmark.js',
  'scripts/run-native-runtime-abi.js',
  'scripts/run-portable-conformance-matrix.js',
  'scripts/portable-conformance-evidence-store.js',
  'scripts/run-portable-execution-hard-gate.js',
  'scripts/run-portable-executor-benchmark.js',
  'scripts/run-portable-fault-protocol-benchmark.js',
  'scripts/run-portable-runtime-abi.js',
  'scripts/run-portable-runtime-package.js',
  'scripts/run-portable-vm-aot.js',
  'scripts/run-portable-vm-conformance.js',
  'scripts/run-portable-vm-std.js',
  'scripts/run-project-build-benchmark.js',
  'scripts/run-public-ai-native-demo.js',
  'scripts/run-real-host-adapter-evidence.js',
  'scripts/run-standalone-cross-platform-ci-claim.js',
  'scripts/run-standalone-fault-host-boundary.js',
  'scripts/run-standalone-minimal-std.js',
  'scripts/run-standalone-portable-vm.js',
  'scripts/run-standalone-semantic-performance-hard-gate.js',
  'scripts/run-standalone-task-lifecycle-core.js',
  'scripts/run-task-runtime-lifecycle-benchmark.js',
  'scripts/test-cli-surface.ps1',
  'scripts/release-contract-smoke.mjs',
  'scripts/run-tracked-tests.js',
  'scripts/source-import-selection.mjs',
  'scripts/validate-public-tree.sh',
  'scripts/validate-release-provenance.mjs',
]

export async function selectFiles(root) {
  const selected = new Set()
  for (const entry of SOURCE_ROOTS) {
    for (const path of await walk(root, entry)) selected.add(path)
  }
  for (const entry of EXPLICIT_PATHS) {
    const stat = await lstat(join(root, entry))
    if (stat.isSymbolicLink()) throw new Error('source-import-symlink')
    if (stat.isDirectory()) {
      for (const path of await walk(root, entry)) selected.add(path)
    } else if (stat.isFile()) {
      selected.add(entry)
    } else {
      throw new Error('source-import-entry-invalid')
    }
  }
  return [...selected].sort(compareUtf8)
}

async function walk(root, relative) {
  const absolute = join(root, relative)
  const entries = await readdir(absolute, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
    if (entry.isDirectory() && ['node_modules', 'scratch', 'target'].includes(entry.name)) {
      continue
    }
    const path = `${relative}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error('source-import-symlink')
    if (entry.isDirectory()) files.push(...await walk(root, path))
    else if (entry.isFile()) files.push(path)
    else throw new Error('source-import-entry-invalid')
  }
  return files
}

// The allowlist is reviewed as a diff. Rendered on one line, admitting a single
// file rewrites every other line with it and buries the admission; rendered one
// path per line, the admission is the only line the diff shows. Both the
// checked-in file and `--refresh` go through this function so the two cannot
// disagree about the layout.
export const ALLOWLIST_SCHEMA = 'revia.source-import-allowlist@1.0.0'

export function renderAllowlist(files) {
  // The last entry carries no comma, so a one-line addition is a one-line diff
  // rather than a rewrite of the entry above it.
  const entries = [...files].sort(compareUtf8).map((path) => `    ${JSON.stringify(path)}`)
  const body = entries.length === 0 ? '' : `\n${entries.join(',\n')}\n  `
  return `{\n  "files": [${body}],\n  "schema": "${ALLOWLIST_SCHEMA}"\n}\n`
}

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}
