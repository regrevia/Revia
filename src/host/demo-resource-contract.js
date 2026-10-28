export const DEMO_RESOURCE_CATALOG = Object.freeze({
  'fs.file': {
    domain_digest: `sha256:${'3'.repeat(64)}`,
    segments: [{
      parameter: 'path',
      type_digest: `sha256:${'4'.repeat(64)}`,
    }],
  },
  'fs.storage': {
    domain_digest: `sha256:${'3'.repeat(64)}`,
    segments: [],
  },
  'process.argv': {
    domain_digest: `sha256:${'1'.repeat(64)}`,
    segments: [],
  },
  'process.stdout': {
    domain_digest: `sha256:${'2'.repeat(64)}`,
    segments: [],
  },
})

export const DEMO_RESOURCE_PARENTS = Object.freeze({
  'fs.file': 'fs.storage',
})

export function demoResourceCatalog(names = Object.keys(DEMO_RESOURCE_CATALOG)) {
  return Object.fromEntries(
    names.map((name) => [name, structuredClone(DEMO_RESOURCE_CATALOG[name])]),
  )
}

export function demoResourceParents() {
  return structuredClone(DEMO_RESOURCE_PARENTS)
}
