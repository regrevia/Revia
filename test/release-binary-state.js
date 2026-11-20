import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Four test files measure the shipped binary `native/target/release/revia` for
// claims the documentation makes about it: exit 66 for an unreadable input, the
// usage banner on exit 64, exit 65 for a rejected source, the wildcard-binding
// rejection, `revia digest` being the sha256 of the bytes, the module count and
// graph revision of `project-surface-check`, and the starter shape of
// `project-init`. Each of them used to ask one question — is the file there —
// and return when it was not, with the honest comment "a checkout that has not
// built the release binary has nothing to measure".
//
// The comment is honest; the report was not. Node reports a test that returned
// early exactly as it reports one that measured and agreed, so seven unmeasured
// claims were counted as passes. Worse, the guard could not see a binary older
// than the source it claims to describe, which is the failure
// `native-lexer-parser.test.js` already refuses for the debug binary: measured
// at `6109b10`, editing `read_byte_input` from 66 to 65 left the release
// consumers green until the rebuild, and only the rebuild turned them red.
// `.github/workflows/validate.yml` used to make the first case the normal one
// rather than an accident: the Node job ran no `cargo` step and `native/target`
// is ignored, so on every hosted run all seven sites returned early and the
// green Node lane said nothing about any of them in either direction. The job
// now builds `--workspace --release --offline` before the suite, which
// `test/tracked-test-runner.test.js` pins, so `absent` is a local checkout that
// has not built rather than the shape of every hosted run.
//
// So the question is asked the way the debug guard asks it, and the answer is
// published where the population can see it. `absent` and `stale` both mean do
// not measure; they are reported with `context.skip()` rather than by returning,
// which writes `<skipped>` into the JUnit report with the reason naming the
// file, and leaves the case count untouched because Node still counts a skipped
// subtest in `<!-- tests N -->`. That keeps `npm test` green in a checkout that
// legitimately has no build output while stopping the run from implying it
// measured everything.
//
// The watched set is the one the debug guard uses: every `.rs` and `.toml` under
// `native/`, skipping `target` so build output cannot make the source look
// newer than the binary it produced.

const RELEASE_PARTS = ['native', 'target', 'release', 'revia']
const WATCHED_EXTENSIONS = ['.rs', '.toml']
const SKIPPED_DIRECTORIES = new Set(['target'])

export function releaseBinaryPath(repositoryRoot) {
  return join(repositoryRoot, ...RELEASE_PARTS)
}

// The newest watched source, as a path and an mtime. A directory that cannot be
// read is skipped rather than treated as absent source: this decides whether to
// measure, and refusing to answer would turn a permission problem into a silent
// pass, which is the fault this file exists to remove.
export function newestWatchedSource(
  directory,
  { statSyncImpl = statSync, readdirSyncImpl = readdirSync } = {},
) {
  let newest = null
  const walk = (current) => {
    let entries
    try {
      entries = readdirSyncImpl(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        walk(path)
        continue
      }
      if (!WATCHED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue
      let stats
      try {
        stats = statSyncImpl(path)
      } catch {
        continue
      }
      if (newest === null || stats.mtimeMs > newest.mtimeMs) {
        newest = { path, mtimeMs: stats.mtimeMs }
      }
    }
  }
  walk(directory)
  return newest
}

// `absent` — there is no binary to measure.
// `stale`  — the binary is older than the newest watched source, so it answers
//            for source it was not built from.
// `fresh`  — measure it.
export function releaseBinaryState(
  repositoryRoot,
  { statSyncImpl = statSync, readdirSyncImpl = readdirSync } = {},
) {
  const binary = releaseBinaryPath(repositoryRoot)
  let stats
  try {
    stats = statSyncImpl(binary)
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent', binary }
    return { state: 'absent', binary, unreadable: error?.code ?? 'unknown' }
  }
  if (!stats.isFile()) return { state: 'absent', binary, unreadable: 'not-a-file' }
  const source = newestWatchedSource(join(repositoryRoot, 'native'), {
    statSyncImpl,
    readdirSyncImpl,
  })
  if (source !== null && source.mtimeMs > stats.mtimeMs) {
    return { state: 'stale', binary, newer: source.path }
  }
  return { state: 'fresh', binary }
}

// One sentence for `context.skip()`, naming the file so a reader of the report
// knows what was not measured instead of guessing.
export function releaseBinarySkipReason(result) {
  if (result.state === 'stale') {
    return `${result.binary} is older than ${result.newer}, so it answers for source it was not built from`
  }
  if (result.unreadable === 'not-a-file') {
    return `${result.binary} is not a file`
  }
  if (result.unreadable !== undefined) {
    return `${result.binary} could not be read (${result.unreadable})`
  }
  return `${result.binary} is not built in this checkout`
}
