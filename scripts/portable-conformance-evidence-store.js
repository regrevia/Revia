import { randomUUID } from 'node:crypto'
import {
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function commitPortableConformanceEvidence({
  destination,
  evidence,
  verify,
} = {}) {
  if (typeof destination !== 'string'
    || destination.length === 0
    || evidence === null
    || typeof evidence !== 'object'
    || Array.isArray(evidence)
    || typeof verify !== 'function') {
    throw new TypeError('invalid portable conformance evidence commit')
  }

  const temporary = join(
    dirname(destination),
    `.portable-conformance-evidence-${randomUUID()}.tmp`,
  )
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(evidence, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
    await verify(temporary)
    await rename(temporary, destination)
    return { ok: true }
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
