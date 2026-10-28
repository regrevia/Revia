import { createHash } from 'node:crypto'

import { serializeCanonicalGraph } from './canonical.js'
import { EXECUTABLE_GRAMMAR_PROFILE } from './executable-grammar-profile.js'
import { graphRevision } from './structured-patch.js'
import { minimalStdPackageIdentityForGraph } from './minimal-std-subset.js'

export const TRANSLATION_ARTIFACT_SCHEMA = 're.execution-artifact@0.1.0'
export const TRANSLATION_RUNTIME_KIND = 'node-demo-reference'
export const TRANSLATION_TARGET_PROFILE = 'node-demo-translator@0.1.0'

export function translateCheckedGraph(
  graph,
  {
    runtimeKind = TRANSLATION_RUNTIME_KIND,
    targetProfile = TRANSLATION_TARGET_PROFILE,
  } = {},
) {
  if (typeof runtimeKind !== 'string' || runtimeKind.length === 0) {
    return rejected({ code: 'invalid-translation-runtime-kind' })
  }
  if (typeof targetProfile !== 'string' || targetProfile.length === 0) {
    return rejected({ code: 'invalid-translation-target-profile' })
  }
  let canonical
  try {
    canonical = serializeCanonicalGraph(graph)
  } catch (error) {
    return rejected({
      actual: error.message,
      code: 'unsupported-translation-graph',
    })
  }
  const canonicalSha256 = digest(canonical)
  const graphRevisionValue = graphRevision(graph)
  const std = minimalStdPackageIdentityForGraph(graph)
  if (!std.ok) return rejected(std.diagnostics[0])
  const identity = {
    canonical_sha256: canonicalSha256,
    graph_revision: graphRevisionValue,
    runtime_kind: runtimeKind,
    schema: TRANSLATION_ARTIFACT_SCHEMA,
    target_profile: targetProfile,
    unit: graph.unit,
    ...(std.value.modules.length === 0 ? {} : {
      std_capability_digest: std.value.capability_digest,
      std_package_digest: std.value.package_digest,
      std_runtime_package_digest: std.value.runtime_package_digest,
    }),
  }
  return {
    ok: true,
    value: {
      artifact_sha256: digest(canonicalJson(identity)),
      canonical: {
        bytes: canonical,
        schema: EXECUTABLE_GRAMMAR_PROFILE.canonical_schema,
        sha256: canonicalSha256,
      },
      graph_revision: graphRevisionValue,
      runtime: { kind: runtimeKind },
      schema: TRANSLATION_ARTIFACT_SCHEMA,
      target_profile: targetProfile,
      unit: graph.unit,
      ...(std.value.modules.length === 0 ? {} : {
        std_capability_digest: std.value.capability_digest,
        std_package_digest: std.value.package_digest,
        std_runtime_package_digest: std.value.runtime_package_digest,
      }),
    },
  }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function rejected(diagnostic) {
  return { diagnostics: [diagnostic], ok: false }
}
