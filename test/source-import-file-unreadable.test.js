import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { ALLOWLIST_SCHEMA } from '../scripts/source-import-selection.mjs'
import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// A listed path that cannot be inspected is neither missing nor invalid: it is
// there, it is a file, and the process is not allowed to look inside the
// directory that holds it. The raw EACCES carried an absolute path, which
// stableCode() drops, so every mode printed the unnamed failure and the
// operator could not tell a permission fault from a real one.
//
// Directories are used rather than files so the case also holds when the suite
// runs as root, where a mode bit on a file would not stop a read.
test('a listed path under a directory it cannot enter is named', async () => {
  for (const mode of ['--check', '--write']) {
    const root = await temporaryRoot('a locked directory')
    await writeFile(
      join(root, 'SOURCE_IMPORT_FILES.json'),
      `${JSON.stringify({ files: ['docs/locked/x.md'], schema: ALLOWLIST_SCHEMA })}\n`,
    )
    const locked = join(root, 'docs/locked')
    await mkdir(locked, { recursive: true })
    await writeFile(join(locked, 'x.md'), 'x\n')
    await chmod(locked, 0o000)

    let result
    try {
      result = await run(root, mode)
    } finally {
      await chmod(locked, 0o755)
    }

    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'source-import-file-unreadable\n')
    assert.equal(result.stdout, '')
  }
})
