import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const manifestPath = fileURLToPath(
  new URL('../../SOURCE_IMPORT_MANIFEST.json', import.meta.url),
)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

if (manifest?.schema !== 'revia.source-import@1.0.0'
  || manifest.license !== 'MPL-2.0'
  || !Array.isArray(manifest.files)
  || manifest.files.length === 0) {
  throw new TypeError('source import manifest is invalid')
}

export const RELEASE_TOOLCHAIN_PATHS = Object.freeze(
  manifest.files.map(({ path }) => path),
)
