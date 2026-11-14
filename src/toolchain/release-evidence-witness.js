const DIGEST = /^sha256:[0-9a-f]{64}$/u
const MEASURED = 'measured-native'

const WITNESS_FIELDS = ['command', 'environment_digest', 'raw_log_sha256']

// A release record is re-derivable only when it says how the numbers were
// observed. `command` is the invocation that produced the witness, and the two
// digests pin the environment it ran in and the raw log it left behind, so a
// reader who was not there can repeat the observation instead of trusting the
// outcome. Records for targets that are not measured claim no witness, and
// asking for one there would invent an obligation the release never made.
export function classifyEvidenceWitness(record) {
  const measured = isPlainObject(record) && record.status === MEASURED
  const witness = isPlainObject(record) ? record.witness : undefined
  if (!measured) {
    return { missing: [], reDerivable: false }
  }
  if (!isPlainObject(witness)) {
    return { missing: ['witness'], reDerivable: false }
  }
  const missing = []
  for (const field of WITNESS_FIELDS) {
    const value = witness[field]
    const present = field === 'command'
      ? typeof value === 'string' && value.trim().length > 0
      : typeof value === 'string' && DIGEST.test(value)
    if (!present) {
      missing.push(`witness.${field}`)
    }
  }
  return { missing, reDerivable: missing.length === 0 }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
