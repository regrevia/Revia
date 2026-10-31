export function serializeRunResult({
  outcome,
  programStdout = '',
  runtimeEffectReceipt,
}) {
  const result = {
    outcome: normalizeRunOutcome(outcome),
    program_stdout: programStdout,
    schema: runtimeEffectReceipt === undefined
      ? 're.run-result@0.1.0'
      : 're.run-result@0.2.0',
  }
  if (runtimeEffectReceipt !== undefined) {
    result.runtime_effect_receipt = runtimeEffectReceipt
  }
  return canonicalJson(result)
}

export function serializeTranslationResult({ file, result }) {
  return canonicalJson(
    result.ok
      ? {
          artifact: result.value,
          file,
          ok: true,
          schema: 're.translation-result@0.1.0',
        }
      : {
          diagnostics: [...result.diagnostics].sort(compareDiagnostics),
          file,
          ok: false,
          schema: 're.translation-result@0.1.0',
        },
  )
}

export function serializeProjectTranslationResult({ file, format = 'json', result }) {
  if (format !== 'json') {
    return result.ok
      ? result.value.renderings[format]
      : `${JSON.stringify({ diagnostics: result.diagnostics, ok: false })}\n`
  }
  return canonicalJson(
    result.ok
      ? {
          file,
          ok: true,
          project: result.value,
          schema: 're.project-translation-result@0.1.0',
        }
      : {
          diagnostics: [...result.diagnostics].sort(compareDiagnostics),
          file,
          ok: false,
          schema: 're.project-translation-result@0.1.0',
        },
  )
}

export function serializeCheckResult({ diagnostics = [], file, ok }) {
  return canonicalJson({
    diagnostics: [...diagnostics].sort(compareDiagnostics),
    file,
    ok,
    schema: 're.check-result@0.1.0',
  })
}

export function serializePatchResult({ file, result }) {
  return canonicalJson(
    result.ok
      ? {
          file,
          ok: true,
          receipt: result.receipt,
          schema: 're.patch-result@0.1.0',
        }
      : {
          diagnostics: result.diagnostics,
          file,
          ok: false,
          schema: 're.patch-result@0.1.0',
        },
  )
}

export function serializeManifestResult({ file, result }) {
  return canonicalJson(
    result.ok
      ? {
          file,
          manifest: result.value,
          ok: true,
          schema: 're.review-manifest@0.1.0',
        }
      : {
          diagnostics: result.diagnostics,
          file,
          ok: false,
          schema: 're.review-manifest@0.1.0',
        },
  )
}

export function serializeBuildResult({ outDir, result }) {
  return canonicalJson(
    result.ok
      ? {
          artifact: result.value.manifest,
          ok: true,
          out_dir: outDir,
          schema: 're.build-result@0.1.0',
        }
      : {
          diagnostics: result.diagnostics,
          ok: false,
          out_dir: outDir,
          schema: 're.build-result@0.1.0',
        },
  )
}

export function serializeReviewIndexResult({ file, result }) {
  return canonicalJson(
    result.ok
      ? {
          file,
          index: result.value,
          ok: true,
          schema: 're.project-review-index-result@0.1.0',
        }
      : {
          diagnostics: result.diagnostics,
          file,
          ok: false,
          schema: 're.project-review-index-result@0.1.0',
        },
  )
}

export function serializeReviewFactResult({ file, result }) {
  return canonicalJson(
    result.ok
      ? {
          fact: result.value,
          file,
          ok: true,
          schema: 're.project-review-fact-result@0.1.0',
        }
      : {
          diagnostics: result.diagnostics,
          file,
          ok: false,
          schema: 're.project-review-fact-result@0.1.0',
        },
  )
}

export function serializeProfileResult({ file, result }) {
  return canonicalJson(
    result.ok
      ? {
          file,
          ok: true,
          profile: result.value,
          schema: 're.profile-result@0.1.0',
        }
      : {
          diagnostics: result.diagnostics,
          file,
          ok: false,
          schema: 're.profile-result@0.1.0',
        },
  )
}

export function serializeModuleSurfaceResult({ file, manifestFile, result }) {
  return canonicalJson(
    result.ok
      ? {
          file,
          manifest_file: manifestFile,
          module: result.value,
          ok: true,
          schema: 're.module-surface-result@0.1.0',
        }
      : {
          diagnostics: [...result.diagnostics].sort(compareDiagnostics),
          file,
          manifest_file: manifestFile,
          ok: false,
          schema: 're.module-surface-result@0.1.0',
        },
  )
}

export function serializeProjectCheckResult({ result }) {
  return canonicalJson(
    result.ok
      ? {
          graph: result.value,
          ok: true,
          schema: 're.project-check-result@0.1.0',
        }
      : {
          diagnostics: [...result.diagnostics].sort(compareDiagnostics),
          ok: false,
          schema: 're.project-check-result@0.1.0',
        },
  )
}

export function serializeProjectRunResult({ fixture, result }) {
  return canonicalJson(
    result.ok
      ? {
          fixture,
          ok: true,
          receipt: result.value,
          schema: 're.project-run-result@0.1.0',
        }
      : {
          diagnostics: [...result.diagnostics].sort(compareDiagnostics),
          fixture,
          ok: false,
          schema: 're.project-run-result@0.1.0',
        },
  )
}

export function serializeInterfaceProjectionResult({ result }) {
  return canonicalJson(
    result.ok
      ? {
          manifest: result.value.manifest,
          ok: true,
          schema: 're.interface-projection-result@0.1.0',
        }
      : {
          diagnostics: [...result.diagnostics].sort(compareDiagnostics),
          ok: false,
          schema: 're.interface-projection-result@0.1.0',
        },
  )
}

export function serializeAuditResult({
  capabilities,
  effects,
  errorPaths,
  statusCodes,
}) {
  return canonicalJson({
    capabilities: [...capabilities].sort((left, right) =>
      compareUtf8(left.instance, right.instance),
    ),
    effects: [...effects]
      .map((effect) => ({
        ...effect,
        access: [...effect.access].sort(compareUtf8),
        result_consumers: [...effect.result_consumers].sort(compareUtf8),
      }))
      .sort((left, right) => compareUtf8(left.node_uid, right.node_uid)),
    error_paths: [...errorPaths]
      .map((path) => ({
        ...path,
        status_codes: sortedUniqueNumbers(path.status_codes),
      }))
      .sort(compareErrorPaths),
    schema: 're.audit-result@0.1.0',
    status_codes: sortedUniqueNumbers(statusCodes),
  })
}

function normalizeRunOutcome(outcome) {
  if (outcome.kind !== 'check-failure') {
    return outcome
  }
  return {
    ...outcome,
    diagnostics: [...outcome.diagnostics].sort(compareDiagnostics),
  }
}

function compareDiagnostics(left, right) {
  return (
    compareUtf8(left.file, right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    compareUtf8(left.code, right.code)
  )
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left ?? ''), Buffer.from(right ?? ''))
}

function compareErrorPaths(left, right) {
  return (
    compareUtf8(left.producer_uid, right.producer_uid) ||
    compareUtf8(left.error_type, right.error_type) ||
    compareUtf8(left.consumer_uid, right.consumer_uid)
  )
}

function sortedUniqueNumbers(values) {
  return [...new Set(values)].sort((left, right) => left - right)
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}
