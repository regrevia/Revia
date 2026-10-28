import { createHash } from 'node:crypto'

import {
  MINIMAL_STD_NATIVE_RUNNER_TARGETS,
  verifyMinimalStdNativeRunnerReceipt,
} from './minimal-std-native-runner.js'

export const MINIMAL_STD_NATIVE_CI_PROFILE =
  're.minimal-std-native-ci@0.1.0'
export const MINIMAL_STD_NATIVE_CI_CLAIM_SCHEMA =
  're.minimal-std-native-ci-claim@0.1.0'
export const MINIMAL_STD_NATIVE_CI_EVIDENCE_SCHEMA =
  're.minimal-std-native-ci-evidence@0.1.0'
export const MINIMAL_STD_NATIVE_CI_POLICY_SCHEMA =
  're.minimal-std-native-ci-policy@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const CHALLENGE = /^[0-9a-f]{64}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u
const CLAIM_FIELDS = [
  'claim_digest',
  'github',
  'profile',
  'receipt',
  'request',
  'schema',
  'status',
  'workflow_digest',
]
const GITHUB_FIELDS = [
  'actor',
  'event_name',
  'job',
  'ref',
  'repository',
  'run_attempt',
  'run_id',
  'runner_arch',
  'runner_environment',
  'runner_name',
  'runner_os',
  'sha',
  'workflow_ref',
  'workflow_sha',
]
const ARTIFACT_FIELDS = [
  'claim_file_digest',
  'created_at',
  'expired',
  'expires_at',
  'id',
  'name',
  'size_in_bytes',
  'workflow_run_id',
]
const RUN_FIELDS = [
  'conclusion',
  'event',
  'head_branch',
  'head_sha',
  'id',
  'path',
  'run_attempt',
  'status',
  'workflow_id',
]
const EVIDENCE_FIELDS = [
  'artifact',
  'claim',
  'evidence_digest',
  'run',
  'schema',
  'status',
]
const POLICY_FIELDS = [
  'artifact_id',
  'challenge',
  'commit',
  'policy_digest',
  'ref',
  'repository',
  'run_id',
  'schema',
  'workflow_path',
]
const LINUX_TARGET = MINIMAL_STD_NATIVE_RUNNER_TARGETS.find(
  ({ id }) => id === 'linux-x64-native-c11-minimal-std',
)

export function createMinimalStdNativeCiClaim({
  github,
  receipt,
  request,
  workflow_source,
} = {}) {
  try {
    validateGithub(github)
    validateWorkflowSource(workflow_source)
    if (!canonicalEqual(request?.target, LINUX_TARGET)
      || !canonicalEqual(receipt?.target, LINUX_TARGET)
      || receipt?.request_digest !== request?.request_digest) {
      fail('minimal-std-native-ci-claim-invalid')
    }
    const claim = {
      github,
      profile: MINIMAL_STD_NATIVE_CI_PROFILE,
      receipt,
      request,
      schema: MINIMAL_STD_NATIVE_CI_CLAIM_SCHEMA,
      status: 'measured',
      workflow_digest: digestBytes(Buffer.from(workflow_source, 'utf8')),
    }
    claim.claim_digest = minimalStdNativeCiClaimDigest(claim)
    validateClaim(claim)
    return { ok: true, value: claim }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-ci-claim-invalid')
  }
}

export async function verifyMinimalStdNativeCiClaim(claim, {
  abi,
  bundle,
  challenge,
  commit,
  corpus,
  package: archive,
  ref,
  repository,
  workflow_path,
  workflow_source,
} = {}) {
  try {
    validateClaim(claim)
    validateWorkflowSource(workflow_source)
    if (!CHALLENGE.test(challenge)
      || !COMMIT.test(commit)
      || !validText(ref)
      || !validText(repository)
      || !validWorkflowPath(workflow_path)) {
      fail('minimal-std-native-ci-authority-invalid')
    }
    const expectedWorkflowRef =
      `${repository}/${workflow_path}@${ref}`
    if (claim.request.challenge !== challenge
      || claim.github.event_name !== 'workflow_dispatch'
      || claim.github.repository !== repository
      || claim.github.ref !== ref
      || claim.github.sha !== commit
      || claim.github.workflow_sha !== commit
      || claim.github.workflow_ref !== expectedWorkflowRef
      || claim.github.job !== 'measure'
      || claim.github.runner_os !== 'Linux'
      || claim.github.runner_arch !== 'X64'
      || claim.github.runner_environment !== 'github-hosted'
      || claim.workflow_digest !== digestBytes(
        Buffer.from(workflow_source, 'utf8'),
      )
      || claim.claim_digest !== minimalStdNativeCiClaimDigest(claim)
      || !canonicalEqual(claim.request.target, LINUX_TARGET)
      || !canonicalEqual(claim.receipt.target, LINUX_TARGET)) {
      fail('minimal-std-native-ci-authority-mismatch')
    }
    const receipt = await verifyMinimalStdNativeRunnerReceipt(
      claim.receipt,
      {
        abi,
        bundle,
        corpus,
        package: archive,
        request: claim.request,
      },
    )
    return receipt.ok ? { ok: true } : receipt
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-ci-claim-invalid')
  }
}

export async function createMinimalStdNativeCiEvidence({
  artifact,
  claim,
  run,
  ...inputs
} = {}) {
  try {
    const verified = await verifyMinimalStdNativeCiClaim(claim, inputs)
    if (!verified.ok) return verified
    validateArtifact(artifact, claim.github)
    validateRun(run, claim.github, inputs)
    const evidence = {
      artifact,
      claim,
      run,
      schema: MINIMAL_STD_NATIVE_CI_EVIDENCE_SCHEMA,
      status: 'measured',
    }
    evidence.evidence_digest = minimalStdNativeCiEvidenceDigest(evidence)
    return { ok: true, value: evidence }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-ci-evidence-invalid')
  }
}

export async function verifyMinimalStdNativeCiEvidence(evidence, inputs = {}) {
  try {
    validateEvidence(evidence)
    const verified = await verifyMinimalStdNativeCiClaim(
      evidence.claim,
      inputs,
    )
    if (!verified.ok) return verified
    validateArtifact(evidence.artifact, evidence.claim.github)
    validateRun(evidence.run, evidence.claim.github, inputs)
    if (evidence.evidence_digest
      !== minimalStdNativeCiEvidenceDigest(evidence)) {
      fail('minimal-std-native-ci-evidence-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-ci-evidence-invalid')
  }
}

export function createMinimalStdNativeCiPolicy({
  artifact_id,
  challenge,
  commit,
  ref,
  repository,
  run_id,
  workflow_path,
} = {}) {
  try {
    const policy = {
      artifact_id,
      challenge,
      commit,
      ref,
      repository,
      run_id,
      schema: MINIMAL_STD_NATIVE_CI_POLICY_SCHEMA,
      workflow_path,
    }
    policy.policy_digest = minimalStdNativeCiPolicyDigest(policy)
    const verified = verifyMinimalStdNativeCiPolicy(policy)
    return verified.ok ? { ok: true, value: policy } : verified
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-ci-policy-invalid')
  }
}

export function verifyMinimalStdNativeCiPolicy(policy) {
  try {
    if (!plainObject(policy) || !exactShape(policy, POLICY_FIELDS)
      || policy.schema !== MINIMAL_STD_NATIVE_CI_POLICY_SCHEMA
      || !POSITIVE_DECIMAL.test(policy.artifact_id)
      || !CHALLENGE.test(policy.challenge)
      || !COMMIT.test(policy.commit)
      || !validText(policy.ref)
      || !validText(policy.repository)
      || !POSITIVE_DECIMAL.test(policy.run_id)
      || !validWorkflowPath(policy.workflow_path)
      || !DIGEST.test(policy.policy_digest)) {
      fail('minimal-std-native-ci-policy-invalid')
    }
    if (policy.policy_digest !== minimalStdNativeCiPolicyDigest(policy)) {
      fail('minimal-std-native-ci-policy-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-ci-policy-invalid')
  }
}

export async function verifyMinimalStdNativeCiReleaseAuthority({
  evidence,
  policy,
  ...inputs
} = {}) {
  try {
    const verifiedPolicy = verifyMinimalStdNativeCiPolicy(policy)
    if (!verifiedPolicy.ok) return verifiedPolicy
    const verifiedEvidence = await verifyMinimalStdNativeCiEvidence(
      evidence,
      {
        ...inputs,
        challenge: policy.challenge,
        commit: policy.commit,
        ref: policy.ref,
        repository: policy.repository,
        workflow_path: policy.workflow_path,
      },
    )
    if (!verifiedEvidence.ok) return verifiedEvidence
    if (policy.artifact_id !== evidence.artifact.id
      || policy.challenge !== evidence.claim.request.challenge
      || policy.commit !== evidence.claim.github.sha
      || policy.commit !== evidence.claim.github.workflow_sha
      || policy.commit !== evidence.run.head_sha
      || policy.ref !== evidence.claim.github.ref
      || policy.repository !== evidence.claim.github.repository
      || policy.run_id !== evidence.claim.github.run_id
      || policy.run_id !== evidence.run.id
      || policy.run_id !== evidence.artifact.workflow_run_id
      || policy.workflow_path !== evidence.run.path) {
      fail('minimal-std-native-ci-release-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(
      error?.code ?? 'minimal-std-native-ci-release-authority-invalid',
    )
  }
}

export function minimalStdNativeCiClaimDigest(claim) {
  const { claim_digest: ignored, ...content } = claim
  return digestValue(content)
}

export function minimalStdNativeCiPolicyDigest(policy) {
  const { policy_digest: ignored, ...content } = policy
  return digestValue(content)
}

export function minimalStdNativeCiEvidenceDigest(evidence) {
  const { evidence_digest: ignored, ...content } = evidence
  return digestValue(content)
}

export function mergeMinimalStdNativeCiClaim(claims, incoming) {
  if (!Array.isArray(claims)
    || !plainObject(incoming)
    || !plainObject(incoming.request)
    || !plainObject(incoming.receipt)
    || incoming.request.target?.id !== incoming.receipt.target?.id
    || !validText(incoming.request.target?.id)) {
    fail('minimal-std-native-ci-claim-merge-invalid')
  }
  const targetId = incoming.request.target.id
  const merged = claims.filter((claim) => (
    claim?.request?.target?.id !== targetId
  ))
  merged.push(incoming)
  return merged.sort((left, right) => (
    left.request.target.id.localeCompare(right.request.target.id)
  ))
}

function validateClaim(claim) {
  if (!plainObject(claim) || !exactShape(claim, CLAIM_FIELDS)
    || claim.schema !== MINIMAL_STD_NATIVE_CI_CLAIM_SCHEMA
    || claim.profile !== MINIMAL_STD_NATIVE_CI_PROFILE
    || claim.status !== 'measured'
    || !DIGEST.test(claim.claim_digest)
    || !DIGEST.test(claim.workflow_digest)
    || !plainObject(claim.request)
    || !plainObject(claim.receipt)) {
    fail('minimal-std-native-ci-claim-invalid')
  }
  validateGithub(claim.github)
}

function validateGithub(github) {
  if (!plainObject(github) || !exactShape(github, GITHUB_FIELDS)
    || !validText(github.actor)
    || github.event_name !== 'workflow_dispatch'
    || github.job !== 'measure'
    || !validText(github.ref)
    || !validText(github.repository)
    || !POSITIVE_DECIMAL.test(github.run_attempt)
    || !POSITIVE_DECIMAL.test(github.run_id)
    || github.runner_arch !== 'X64'
    || github.runner_environment !== 'github-hosted'
    || !validText(github.runner_name)
    || github.runner_os !== 'Linux'
    || !COMMIT.test(github.sha)
    || !validText(github.workflow_ref)
    || !COMMIT.test(github.workflow_sha)) {
    fail('minimal-std-native-ci-github-invalid')
  }
}

function validateArtifact(artifact, github) {
  const created = Date.parse(artifact?.created_at)
  const expires = Date.parse(artifact?.expires_at)
  if (!plainObject(artifact) || !exactShape(artifact, ARTIFACT_FIELDS)
    || !DIGEST.test(artifact.claim_file_digest)
    || !Number.isFinite(created)
    || artifact.expired !== false
    || !Number.isFinite(expires)
    || expires <= created
    || !POSITIVE_DECIMAL.test(artifact.id)
    || artifact.name
      !== `minimal-std-native-linux-${github.run_id}-${github.run_attempt}`
    || !Number.isSafeInteger(artifact.size_in_bytes)
    || artifact.size_in_bytes <= 0
    || artifact.workflow_run_id !== github.run_id) {
    fail('minimal-std-native-ci-artifact-mismatch')
  }
}

function validateRun(run, github, {
  commit,
  ref,
  workflow_path,
} = {}) {
  const branch = ref?.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : null
  if (!plainObject(run) || !exactShape(run, RUN_FIELDS)
    || run.conclusion !== 'success'
    || run.event !== 'workflow_dispatch'
    || run.head_branch !== branch
    || run.head_sha !== commit
    || run.id !== github.run_id
    || run.path !== workflow_path
    || run.run_attempt !== github.run_attempt
    || run.status !== 'completed'
    || !POSITIVE_DECIMAL.test(run.workflow_id)) {
    fail('minimal-std-native-ci-run-mismatch')
  }
}

function validateEvidence(evidence) {
  if (!plainObject(evidence) || !exactShape(evidence, EVIDENCE_FIELDS)
    || evidence.schema !== MINIMAL_STD_NATIVE_CI_EVIDENCE_SCHEMA
    || evidence.status !== 'measured'
    || !plainObject(evidence.artifact)
    || !plainObject(evidence.claim)
    || !plainObject(evidence.run)
    || !DIGEST.test(evidence.evidence_digest)) {
    fail('minimal-std-native-ci-evidence-invalid')
  }
}

function validateWorkflowSource(source) {
  if (typeof source !== 'string' || source.length === 0
    || !source.includes('name: Minimal std native Linux evidence')
    || !source.includes('workflow_dispatch:')
    || !source.includes('permissions:')
    || !source.includes('contents: read')) {
    fail('minimal-std-native-ci-workflow-invalid')
  }
}

function validWorkflowPath(value) {
  return typeof value === 'string'
    && /^\.github\/workflows\/[a-z0-9-]+\.yml$/u.test(value)
}

function validText(value) {
  return typeof value === 'string' && value.length > 0
}

function exactShape(value, fields) {
  return plainObject(value)
    && canonicalEqual(Object.keys(value).sort(), [...fields].sort())
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function digestValue(value) {
  return digestBytes(Buffer.from(canonicalJson(value), 'utf8'))
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
