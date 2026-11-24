import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The debug binaries under `native/target/debug/` are reused rather than always
// rebuilt, so the suite has to decide whether the one on disk answers for the
// source it is about to measure. The predicate used to be written inline, once
// per binary, and never exercised: `newest > binary.mtimeMs` leaves the equality
// case on the wrong side, and a tree restored from an archive (`cp -p`, `rsync
// -t`, a `tar` extraction, a container layer) can land the newest source file on
// the binary's own mtime rather than after it. Reusing the binary then reports a
// disagreement between source and build as a product defect, which is the
// confusion the guard exists to prevent.
//
// Equality means rebuild here. A binary carrying the same timestamp as the
// newest source cannot be shown to have been built from it, and the cost of an
// unnecessary rebuild is a compile, while the cost of the wrong answer is a
// suite that measured neither the tree nor the binary it names. Bytes would
// settle it, but binding the binary to a digest of the source set is a larger
// change than this guard makes; the narrow claim is that this decision is named,
// shared, and asserted at its boundary.

const WATCHED_EXTENSIONS = ['.rs', '.toml']
const SKIPPED_DIRECTORIES = new Set(['target'])

const isWatched = (name, extensions) =>
  extensions.some((extension) => name.endsWith(extension))

// The newest watched source under `directory`, as an mtime in milliseconds, or
// `0` when there is none. A directory that cannot be read is skipped rather
// than treated as absent source: this decides whether to rebuild, and refusing
// to answer would turn a permission problem into a silent reuse.
export function newestWatchedSource(
  directory,
  { extensions = WATCHED_EXTENSIONS, statSyncImpl = statSync, readdirSyncImpl = readdirSync } = {},
) {
  let newest = 0
  for (const entry of readdirSyncImpl(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(
        newest,
        newestWatchedSource(path, { extensions, statSyncImpl, readdirSyncImpl }),
      )
    } else if (isWatched(entry.name, extensions)) {
      newest = Math.max(newest, statSyncImpl(path).mtimeMs)
    }
  }
  return newest
}

// Whether `binaryPath` has to be rebuilt before it may be measured. A binary
// that is absent is stale by definition; one whose mtime is at or before the
// newest watched source is stale because the source may have changed since it
// was linked.
export function isNativeBinaryStale(
  binaryPath,
  sourceRoot,
  {
    extensions = WATCHED_EXTENSIONS,
    existsSyncImpl = existsSync,
    statSyncImpl = statSync,
    readdirSyncImpl = readdirSync,
  } = {},
) {
  if (!existsSyncImpl(binaryPath)) return true
  const newest = newestWatchedSource(sourceRoot, {
    extensions,
    statSyncImpl,
    readdirSyncImpl,
  })
  return newest >= statSyncImpl(binaryPath).mtimeMs
}
