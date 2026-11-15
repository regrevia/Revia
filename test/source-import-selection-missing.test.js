import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// The builder cannot check a list without the module that renders and reads
// it, and that module is a tracked file the build must publish. Losing it is
// not a stale allowlist entry and no refresh brings it back, so it has to be
// reported as its own fault. A static import raised ERR_MODULE_NOT_FOUND
// before the try block, which let a Node stack reach stderr in every mode.
test('a missing selection module is named in every mode', async () => {
  for (const mode of ['--check', '--write', '--refresh']) {
    const root = await temporaryRoot('nothing-is-missing')
    await rm(join(root, 'scripts/source-import-selection.mjs'), { force: true })

    const result = await run(root, mode)

    assert.equal(result.status, 1, mode)
    assert.equal(result.stderr, 'source-import-selection-missing\n', mode)
    assert.equal(result.stdout, '', mode)
  }
})
