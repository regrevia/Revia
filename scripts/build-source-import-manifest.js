#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Filled from the selection module inside the guarded block below, so a tree
// that lost that module reports a name instead of a Node stack.
let ALLOWLIST_SCHEMA
let compareUtf8
let renderAllowlist
let selectFiles

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const ALLOWLIST = join(ROOT, 'SOURCE_IMPORT_FILES.json')
const MANIFEST = join(ROOT, 'SOURCE_IMPORT_MANIFEST.json')
// A leading mark is well-formed UTF-8, so nothing below can tell a marked
// document from a corrupt one once it has been decoded: the bytes are refused
// here, by name, before any parse or comparison sees the text.
const BYTE_ORDER_MARK = Buffer.from([0xef, 0xbb, 0xbf])
const BYTE_ORDER_MARK_CODE = 'byte-order-mark-not-allowed'

// The mode decides whether the tree is written, so it is the one argument
// that may not be guessed. Reading the first one and ignoring the rest let a
// command line that named a writing mode anywhere still write under a name
// that reads like the checking one — the operator sees `--check` and the tree
// moves. Two jobs is not a preference to resolve by position; it is a command
// line that does not say what to do, and the usage line is the answer.
const modes = process.argv.slice(2)
const mode = modes.length === 1 ? modes[0] : undefined
if (!['--refresh', '--write', '--check'].includes(mode)) {
  process.stderr.write(
    'Usage: node scripts/build-source-import-manifest.js --refresh|--write|--check\n' +
      'The gate names exactly one mode.\n',
  )
  process.exit(64)
}

try {
  // The module that reads and renders the list is a tracked file the build
  // must publish, so losing it is not a stale entry and no refresh brings it
  // back. A static import would raise before this block and let a Node stack
  // reach stderr; loading it here keeps every fault named. Three faults need
  // three names because the repair differs: a missing module is restored from
  // Git, one the process may not open is mode bits, and one that is present
  // but will not parse is source to fix. The third reached the operator as
  // `source-import-failed`, the fallback that drops everything it was told —
  // so the one file that has to change was never named in the one place that
  // knows it. The loader's own message is not a substitute: it is
  // `Unexpected end of input` with neither file nor position, and only one
  // module can be meant, so the code names it instead of carrying a path.
  ;({ ALLOWLIST_SCHEMA, compareUtf8, renderAllowlist, selectFiles } =
    await import('./source-import-selection.mjs').catch((error) => {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error('source-import-selection-missing')
      }
      // A module the process may not open never parses, so a permission is
      // not a syntax fault: the file is intact and mode bits are the repair.
      if (error?.code === 'EACCES' || error?.code === 'EPERM') {
        throw new Error('source-import-selection-unreadable')
      }
      if (error instanceof SyntaxError) {
        throw new Error('source-import-selection-invalid')
      }
      throw error
    }))
  // The list is read in every mode and rewritten in one, and a link is
  // neither a list nor an absent one: the write would land on whatever it
  // points at while the tracked file stayed a link, and a dangling link reads
  // exactly like a tree that never had a list.
  // The receipt describes what the mode did to each file, in one vocabulary:
  // a mode that writes nothing reports `unchanged`, which is what it did.
  let allowlistTransition = 'unchanged'
  const allowlistStat = await lstat(ALLOWLIST).catch(() => null)
  if (allowlistStat?.isSymbolicLink()) {
    throw new Error('source-import-allowlist-symlink')
  }
  // A pipe, a socket or a device is none of the things the modes below can
  // use, and every one of them opens and then holds the reader: the gate would
  // stop with no answer at all instead of naming what to remove. Only those
  // three are refused here — a directory already has its own names, and asking
  // this question of it would rename faults the ledger already describes.
  if (allowlistStat && !allowlistStat.isFile() && !allowlistStat.isDirectory()) {
    throw new Error('source-import-allowlist-invalid-kind')
  }
  // Only --refresh walked the roots, so a pipe, a socket or a device standing
  // inside one was refused by that mode alone: the tree the writing mode would
  // not touch was called clean by the two modes that read, and the operator who
  // ran --check was told nothing was wrong with it. The walk is the only thing
  // that sees those objects, so every mode walks the same roots before it
  // decides, and --refresh publishes exactly the files it names here.
  const files = await selectFiles(ROOT)
  // --refresh writes the list, and the two writes this mode may make are
  // committed together further down: what this block decides is the bytes and
  // the transition, not whether the write lands. Splitting them was how a
  // refresh that could not land the manifest had already repaired the list.
  let rendered = null
  if (mode === '--refresh') {
    // --check refuses a marked allowlist, so --refresh has to refuse it too;
    // rewriting the file would silently erase the one thing that was wrong.
    // A path that holds something other than a file cannot carry a mark, so
    // there is nothing here to refuse and the write below reports the fault.
    await readMarked(ALLOWLIST).catch((error) => {
      if (error?.code === 'EISDIR') return null
      // A list the process may not read stops this mode as surely as one it
      // may not write, and the raw refusal carried a path stableCode() drops.
      // Only a file-system error is mapped: the mark refusal carries no code
      // and has to reach the operator as itself.
      if (typeof error?.code === 'string') {
        throw new Error('source-import-allowlist-unreadable')
      }
      throw error
    })
    rendered = renderAllowlist(files)
    // A caller cannot tell a repair from a no-op by the bytes it gets back,
    // because both leave the same tree and print the same receipt. Reading
    // what was there first is the only place the difference exists, and it is
    // recorded rather than reported: --refresh exists to write a list a tree
    // does not have, so succeeding at that must stay exit 0.
    // Only an absent list is a creation. A list that is there but unreadable
    // already stopped this mode above, so the second arm is ENOENT alone and
    // never covers a fault that has its own name.
    // `readMarked` answers null when there is no list at all, and a list that
    // cannot be read is the case `created` names: nothing was there to keep.
    // A list that publishes exactly the same files in another order is the one
    // difference the reading modes refuse and this mode repairs without
    // changing what the tree publishes, and `replaced` described it the same
    // way as a list that gained or lost a path. Naming it is the only way the
    // operator learns the repair touched the order and nothing else.
    allowlistTransition = await readMarked(ALLOWLIST).then(
      (previous) => {
        if (previous === null) return 'created'
        if (previous.toString('utf8') === rendered) return 'unchanged'
        return reordersOnly(previous, files) ? 'reordered' : 'replaced'
      },
      () => 'created',
    )
  }
  // The manifest describes the list this mode will leave behind, and --refresh
  // is about to leave a different one: reading the file after that write
  // described a list the mode had already published, which is why the two
  // writes could not be ordered safely. The rendered list is exactly the files
  // the walk named, so the manifest is the same bytes either way.
  const allowlist = mode === '--refresh' ? { files } : await readAllowlist()
  const manifest = await buildManifest(allowlist)
  const bytes = Buffer.from(canonicalJson(manifest))
  // Every mode either compares the manifest or replaces it, and a link is
  // neither: the write would land on whatever it points at, leave the link in
  // the tree, and still report the bytes it computed. Reading follows the link
  // too, so a dangling one looks exactly like an absent manifest. Letting
  // ENOENT through keeps the missing case with the modes that own it.
  const manifestStat = await lstat(MANIFEST).catch(() => null)
  if (manifestStat?.isSymbolicLink()) {
    throw new Error('source-import-manifest-symlink')
  }
  // Same refusal for the same reason: these files are opened in every mode, so
  // a pipe here would hold whichever mode ran rather than report anything.
  if (manifestStat && !manifestStat.isFile() && !manifestStat.isDirectory()) {
    throw new Error('source-import-manifest-invalid-kind')
  }
  let manifestTransition = 'unchanged'
  if (mode === '--check') {
    // The manifest is compared, not parsed, so a missing one is not drift: no
    // bytes to differ from. Reading it threw a raw ENOENT with an absolute
    // path, which stableCode() drops to the unnamed failure.
    // An absent manifest and a path that holds something other than one are
    // different repairs, and only the first is --refresh's job: a directory
    // here is never made a manifest by writing one. The raw EISDIR carried an
    // absolute path that stableCode() dropped.
    const existing = refuseMark(await readFile(MANIFEST).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error('source-import-manifest-missing')
      throw new Error('source-import-manifest-unreadable')
    }))
    if (!existing.equals(bytes)) throw new Error('source-import-manifest-drift')
    // The manifest is built from the list, so an unlisted source file that
    // landed under a walked root was never in the bytes above and this mode
    // called that tree clean. It is checked last because the refusal it names
    // only covers a tree every earlier answer called clean: a marked list, an
    // unreadable one, a missing manifest or a drifted one are separate repairs
    // and keep their own names. The walk already happened for the object check,
    // so the published set is here without walking twice. `--write` writes the
    // manifest for the list it read rather than reporting on the tree and
    // `--refresh` is the repair, so neither refuses. One direction only: a
    // listed path the tree lost stays `source-import-file-missing`, because
    // the file is what has to come back and no list edit describes it.
    const named = new Set(allowlist.files)
    if (files.some((path) => !named.has(path))) {
      throw new Error('source-import-allowlist-stale')
    }
  } else {
    // The write either lands or it does not, so every failure here is the
    // same fault: the path cannot take the file. A directory sitting on it
    // threw EISDIR with an absolute path, which stableCode() dropped to the
    // unnamed failure.
    const previous = await readFile(MANIFEST).catch(() => null)
    manifestTransition = previous === null
      ? 'created'
      : (previous.equals(bytes) ? 'unchanged' : 'replaced')
  }
  // Both files this mode writes, asked before either one is. A refusal that
  // landed half of its work is not a refusal, it is a tree that moved under a
  // name saying it did not: the list used to be written before the manifest
  // was even asked about, so a manifest that could not take the bytes exited
  // non-zero with the repair it refused already on disk. Asking the targets
  // first is the only point where both answers are still ahead of the bytes.
  // The probe does not open them, so a target that cannot take the file is
  // left exactly as it was found rather than truncated by the question.
  const writeList = mode === '--refresh' && allowlistTransition !== 'unchanged'
  // A directory on the manifest path is an unreadable manifest to --check and
  // keeps that name, and no write turns a directory into a file: the writing
  // modes name the write they cannot do, and they name it here rather than
  // after the list has been repaired.
  if (mode !== '--check' && manifestTransition !== 'unchanged' && manifestStat?.isDirectory()) {
    throw refusal('source-import-manifest-unwritable', allowlistTransition)
  }
  if (writeList) {
    await assertTakes(ALLOWLIST, 'source-import-allowlist-unwritable', allowlistTransition)
  }
  const writeManifest = mode !== '--check' && manifestTransition !== 'unchanged'
  if (writeManifest) {
    await assertTakes(MANIFEST, 'source-import-manifest-unwritable', allowlistTransition)
  }
  // A list that already holds these bytes has nothing to write, and the
  // transition is not a description of an attempt: writing anyway made
  // `unchanged` a claim only the bytes kept, and on a read-only tree it
  // turned the word into a refusal about a list that needed no repair. The
  // manifest side has guarded its write this way all along.
  // `reordered` still writes, because that name is the news that the order
  // was repaired rather than found correct.
  if (writeList) {
    await writeFile(ALLOWLIST, rendered).catch(() => {
      throw refusal('source-import-allowlist-unwritable', allowlistTransition)
    })
  }
  // A manifest that already holds these bytes has nothing to write, and the
  // transition is not a description of an attempt: writing anyway would
  // touch a correct file and make `unchanged` a claim only the bytes keep.
  // A path that cannot be read above leaves the transition `created`, so the
  // write still runs and still names the path that will not take it.
  if (writeManifest) {
    await writeFile(MANIFEST, bytes).catch(() => {
      throw refusal('source-import-manifest-unwritable', allowlistTransition)
    })
  }
  const receipt = {
    allowlist_transition: allowlistTransition,
    file_count: manifest.files.length,
    manifest_digest: digest(bytes),
    manifest_transition: manifestTransition,
    schema: 'revia.source-import-manifest-result@1.0.0',
  }
  process.stdout.write(`${canonicalJson(receipt)}`)
} catch (error) {
  process.stderr.write(`${stableCode(error)}\n`)
  // A refusal is a claim the mode could not make good, and it is not the
  // absence of a decision: the transition is computed before the write that
  // failed, so dropping it here left every success machine-readable and every
  // failure a bare exit code. Only a mode that got as far as a decision
  // carries one; a refusal that never read that far prints nothing, because a
  // fabricated `unchanged` would look exactly like a mode that looked and
  // agreed.
  if (error?.receipt !== undefined) {
    process.stdout.write(`${canonicalJson(error.receipt)}`)
  }
  process.exitCode = 1
}

async function readAllowlist() {
  // --refresh writes this file; every other mode reads it. Without it there is
  // no list to compare or to write from, and the raw ENOENT it threw carried
  // an absolute path that stableCode() dropped to the unnamed failure.
  // An absent list and a path that holds something other than a list are
  // different repairs, and only the first is --refresh's job. The second never
  // reaches a parse, so no content name below can describe it; the raw EISDIR
  // carried an absolute path that stableCode() dropped.
  const source = await readFile(ALLOWLIST).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error('source-import-allowlist-missing')
    throw new Error('source-import-allowlist-unreadable')
  })
  // A list that is present but holds nothing JSON.parse() can read is not a
  // stale entry and not a layout the schema can describe: it is a file that
  // has to be restored, and the raw SyntaxError carried no name from the
  // vocabulary, so every mode used to print the unnamed failure.
  const value = (() => {
    try {
      return JSON.parse(refuseMark(source).toString('utf8'))
    } catch (error) {
      if (error?.message === BYTE_ORDER_MARK_CODE) throw error
      throw new Error('source-import-allowlist-unparseable')
    }
  })()
  if (value?.schema !== ALLOWLIST_SCHEMA
    || !Array.isArray(value.files)
    || value.files.length === 0
    || value.files.some((path) => !safePath(path))) {
    throw new Error('source-import-allowlist-invalid')
  }
  // A list can name the same path twice in the rendered order. Nothing about
  // that file's order is wrong, so it is the shape the schema cannot read and
  // not the fault `order-invalid` names: told it was the order, the operator
  // would go and look at an ordering that was already correct.
  const sorted = [...new Set(value.files)].sort(compareUtf8)
  if (sorted.length !== value.files.length) {
    throw new Error('source-import-allowlist-invalid')
  }
  if (value.files.some((path, index) => path !== sorted[index])) {
    throw new Error('source-import-allowlist-order-invalid')
  }
  return value
}

function refuseMark(bytes) {
  if (bytes.subarray(0, BYTE_ORDER_MARK.length).equals(BYTE_ORDER_MARK)) {
    throw new Error(BYTE_ORDER_MARK_CODE)
  }
  return bytes
}

async function readMarked(path) {
  try {
    return refuseMark(await readFile(path))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

// Whether the list that is already there publishes the same set of paths as
// the refresh computed, and differs only in the order it names them. Anything
// else — a path added, a path dropped, a list that cannot be parsed — is a
// change to what the tree publishes, which `replaced` describes. A list the
// reading modes would refuse as unparseable has no order to compare.
function reordersOnly(previous, files) {
  let parsed
  try {
    parsed = JSON.parse(previous.toString('utf8'))
  } catch {
    return false
  }
  if (!Array.isArray(parsed?.files) || parsed.files.length !== files.length) {
    return false
  }
  const before = new Set(parsed.files)
  if (before.size !== files.length) return false
  // The same paths in the same order are not a repair to the order, however
  // differently the bytes around them are written: a list that lost its final
  // newline or was re-indented publishes exactly what `--refresh` renders and
  // no path moved, so `reordered` would be reporting the wrapper. This name is
  // the news that the order was repaired, and only a path in another place is
  // that news. `replaced` covers the rest, including this repair.
  return !files.every((path, index) => parsed.files[index] === path)
    && files.every((path) => before.has(path))
}

async function buildManifest(allowlist) {
  const files = []
  for (const path of allowlist.files) {
    const absolute = join(ROOT, path)
    // A path that is not there and a path that is there but is not a file are
    // different repairs: one means the allowlist is stale, the other means the
    // tree holds a directory or a link where a file belongs.
    const stat = await lstat(absolute).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error('source-import-file-missing')
      // Everything else is a path the process cannot look at: a directory it
      // may not enter, a mount that went away, a file whose name is too long.
      // The raw error carried an absolute path that stableCode() drops.
      throw new Error('source-import-file-unreadable')
    })
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('source-import-file-invalid')
    }
    // The stat said it was a file; the read can still be refused, and a race
    // that removed it between the two calls is the same repair as before.
    const bytes = await readFile(absolute).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error('source-import-file-missing')
      throw new Error('source-import-file-unreadable')
    })
    files.push({
      bytes: bytes.length,
      path,
      sha256: digest(bytes),
    })
  }
  return {
    files,
    license: 'MPL-2.0',
    schema: 'revia.source-import@1.0.0',
  }
}

function safePath(path) {
  if (typeof path !== 'string' || path.length === 0
    || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  const segments = path.split('/')
  return segments.every((segment) => (
    segment.length > 0 && segment !== '.' && segment !== '..'
  )) && segments[0] !== '.git'
}

function canonicalJson(value) {
  return `${JSON.stringify(sortValue(value))}\n`
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort(compareUtf8).map((key) => [key, sortValue(value[key])]),
    )
  }
  return value
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// A refusal name is a word this gate published, not a word that happens to
// look like one. Matching on shape let any lowercase token through, so a
// thrower reached the operator wearing the gate's own vocabulary and read
// as a code the guide documents. Everything the gate raises lives in one
// namespace, plus the marked-list code, and anything else keeps the
// fallback — which is the only reason the fallback exists.
// The receipt a refusal carries: what the mode had already decided, plus the
// name it refused with, so a caller reading only stdout still learns both. It
// is a smaller document than the success receipt on purpose — the manifest
// digest describes bytes a failed write never published, and printing it would
// claim a tree state that does not exist.
// Both files a writing mode may replace are asked before either is written, so
// a refusal still describes a tree it did not touch. The question is whether
// the target can take the bytes, which is a permission on the file when it is
// there and on its directory when it is not: a refresh that has to create the
// list is asking the directory, and a manifest that exists but is read-only is
// asking the file. `access` answers from the mode bits without opening
// anything, so a target that cannot take the file is left exactly as it was
// found rather than truncated by the question.
async function assertTakes(path, reason, allowlistTransition) {
  const stat = await lstat(path).catch(() => null)
  // A target that is there has to be a regular file: a directory or a pipe
  // standing on the path is not a write that would land, it is a path that
  // has to be moved out of the way. Both are already named closer to the open
  // for the manifest, and the list reaches here for the same reason.
  if (stat !== null) {
    if (!stat.isFile()) throw refusal(reason, allowlistTransition)
    await access(path, constants.W_OK).catch(() => {
      throw refusal(reason, allowlistTransition)
    })
    return
  }
  await access(dirname(path), constants.W_OK).catch(() => {
    throw refusal(reason, allowlistTransition)
  })
}

function refusal(reason, allowlistTransition) {
  return Object.assign(new Error(reason), {
    receipt: {
      allowlist_transition: allowlistTransition,
      reason,
      schema: 'revia.source-import-refusal@1.0.0',
    },
  })
}

function stableCode(error) {
  const message = error?.message
  if (typeof message !== 'string') return 'source-import-failed'
  if (message === BYTE_ORDER_MARK_CODE) return message
  return /^source-import-[a-z0-9-]+$/u.test(message)
    ? message
    : 'source-import-failed'
}
