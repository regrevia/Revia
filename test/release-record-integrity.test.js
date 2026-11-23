import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import test from 'node:test'

const repository = new URL('../', import.meta.url)
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/u
const SELF = 'export-manifest.json'

// Every release directory pins the payloads it published, and
// `rc1-sealed-export-contract.md` requires "the exact byte size and SHA-256"
// for each of them. The gate in `release-records.test.js` reads the path sets
// and the version strings out of those records and never opens the files they
// name, so a pin could keep a digest for bytes the tree no longer holds.
// `v1.0.0-rc.2.2.1` shipped in exactly that shape: `target-matrix.json` was
// repaired after the tag without the pin following it, and every record test
// stayed green because a stale digest is still a well-formed digest.
//
// Two entries cannot be read here, and neither is a defect:
//
// - `export-manifest.json` pins itself in `rc2.2`. A file cannot carry its own
//   digest, so the pinned copy is the record as it stood before the pin list
//   grew. Skipping it keeps the structural consequence of that growth out of
//   the report the guard is meant to give.
// - Licenses, the checksum list and the archives exist only in the published
//   export. A record names them so the manifest describes the whole payload
//   set, and Git never holds them, so an absent one is the release's shape
//   rather than a file the tree lost. The kinds are listed one by one so that
//   a record the tree should hold cannot go missing under the same skip.
const RELEASE_ONLY = /^(?:LICENSE-RC\.md|NOTICE-RC\.md|checksums\.txt|revia-[^/]+\.(?:tar\.gz|zip))$/u

async function releaseDirectories() {
  const entries = await readdir(new URL('runtime/', repository), { withFileTypes: true })
  const directories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      await stat(new URL(`runtime/${entry.name}/${SELF}`, repository))
    } catch {
      continue
    }
    directories.push(entry.name)
  }
  return directories.sort()
}

test('every published payload a release record pins matches the bytes in the tree', async () => {
  const directories = await releaseDirectories()
  assert.ok(
    directories.length >= 5,
    `only ${directories.length} release directories carry an export manifest`,
  )

  let hashed = 0
  for (const name of directories) {
    const base = `runtime/${name}/`
    const manifest = JSON.parse(await readFile(new URL(`${base}${SELF}`, repository), 'utf8'))
    const entries = manifest.files ?? manifest.assets ?? manifest.entries
    assert.ok(
      Array.isArray(entries) && entries.length > 0,
      `${name} publishes no payload list`,
    )
    const paths = entries.map((entry) => entry.path)
    assert.equal(
      new Set(paths).size,
      paths.length,
      `${name} pins the same path more than once`,
    )

    let read = 0
    for (const entry of entries) {
      assert.equal(typeof entry.path, 'string', `${name} pins a payload with no path`)
      if (entry.path === SELF) continue

      let bytes
      try {
        bytes = await readFile(new URL(`${base}${entry.path}`, repository))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        assert.match(
          entry.path,
          RELEASE_ONLY,
          `${name} pins ${entry.path}, which the tree does not hold`,
        )
        continue
      }

      assert.match(entry.sha256, DIGEST, `${name}/${entry.path} pins no digest`)
      const digest = createHash('sha256').update(bytes).digest('hex')
      assert.equal(
        digest,
        entry.sha256.replace(/^sha256:/u, ''),
        `${name}/${entry.path} does not match its pinned digest`,
      )
      assert.equal(
        bytes.length,
        entry.size,
        `${name}/${entry.path} does not match its pinned size`,
      )
      hashed += 1
      read += 1
    }

    assert.ok(
      read > 0,
      `${name} pins no payload the tree holds, so this release was never read`,
    )
  }

  assert.ok(hashed >= 20, `only ${hashed} published payloads were read`)
})
