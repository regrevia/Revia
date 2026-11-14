const SCHEMA = 'revia.loader-path-probe@1.0.0'
const MEASURED = 'measured'
const PATHED = /^[^\s:]+libc\.so\.6$/u

// The page says a loader failure reads the same whatever path the loader
// reports `libc.so.6` from. That is a claim about one observation made from two
// invocations, so it is recordable only when both were made: a record has to
// carry two loader-reported paths whose diagnostics are identical once the path
// is masked. Anything less leaves the claim unmeasured, and the page has to say
// so rather than stand on an example nobody re-ran.
export function classifyLoaderPathProbe(record) {
  const unrecorded = { measured: false, observedPaths: 0, pathIndependent: false }
  if (!isPlainObject(record) || record.schema !== SCHEMA || record.status !== MEASURED) {
    return unrecorded
  }
  const probes = Array.isArray(record.probes) ? record.probes : []
  const paths = new Set()
  const messages = new Set()
  for (const probe of probes) {
    if (!isPlainObject(probe) || typeof probe.libc_path !== 'string' || !PATHED.test(probe.libc_path)) {
      return unrecorded
    }
    if (typeof probe.diagnostic !== 'string' || probe.diagnostic.trim().length === 0) {
      return unrecorded
    }
    paths.add(probe.libc_path)
    messages.add(probe.diagnostic.replace(probe.libc_path, '<libc>'))
  }
  if (paths.size < 2) {
    return { measured: false, observedPaths: paths.size, pathIndependent: false }
  }
  return { measured: true, observedPaths: paths.size, pathIndependent: messages.size === 1 }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const LOADER_PATH_PROBE_SCHEMA = SCHEMA
