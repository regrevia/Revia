#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  coldStartValueDigest,
  evaluateColdStartAttempt,
} from './cold-start-harness.js'
import { parseExecutableSource } from './executable-source.js'
import { deterministicUidFactory } from './graph-identity.js'
import { checkProgram } from './checker.js'
import { commit, createGraph } from './creation-transaction.js'
import { applyStructuredPatch, graphRevision } from './structured-patch.js'
import { serializeCanonicalGraph } from './canonical.js'
import {
  moduleInterfaceDigest,
  packageManifestDigest,
  resolveModuleImport,
  validatePackageManifest,
} from './module-contract.js'
import { demoSchemaDefinitions } from '../host/demo-schema.js'
import { SchemaRegistry } from '../host/schema-registry.js'
import {
  assertReleaseLock,
  loadReleaseLock,
  releaseLockDigest,
} from './release-lock.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'
const DIGEST = /^sha256:[0-9a-f]{64}$/
const TRACE_FIELDS = ['input_digest', 'output_digest', 'sequence', 'status', 'tool']
const MODEL_IDS = Object.freeze(['model-a', 'model-b', 'model-c'])
const RELEASE_LOCK_URL = new URL('../../test/fixtures/g6-release-lock.json', import.meta.url)
const TASK_PACK_URL = new URL('../../test/fixtures/cold-start-tasks.json', import.meta.url)
const registry = SchemaRegistry.load(demoSchemaDefinitions()).value

export async function runOllamaColdStart({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  modelBindings,
  pack,
  taskIds,
  toolsEnabled = false,
  releaseLock,
} = {}) {
  assertFetch(fetchImpl)
  pack ??= await loadPack()
  releaseLock ??= await loadReleaseLock(RELEASE_LOCK_URL)
  assertReleaseLock(releaseLock, pack, await taskPackDigest())
  const lockDigest = releaseLockDigest(releaseLock)
  taskIds ??= pack.tasks.map(({ id }) => id)
  assertBindings(modelBindings, pack)
  const reports = []

  for (const model of MODEL_IDS) {
    for (const taskId of taskIds) {
      const task = pack.tasks.find(({ id }) => id === taskId)
      if (task === undefined) throw new TypeError(`unknown cold-start task: ${taskId}`)
      const modelName = modelBindings[model]
      const prompt = buildPrompt(pack, task, { lockDigest, releaseLock })
      const attempt = toolsEnabled
        ? await runToolAgent({
          baseUrl,
          fetchImpl,
          modelName,
          pack,
          prompt: buildPrompt(pack, task, {
            lockDigest,
            releaseLock,
            toolsEnabled: true,
          }),
          task,
          releaseLock,
        })
        : await runProbeAgent({ baseUrl, fetchImpl, modelName, prompt, releaseLock })
      const parsed = attempt.parsed
      const candidateOutput = parsed.output
      const output = isPlainObject(candidateOutput)
        ? candidateOutput
        : { runner_error: attempt.error ?? 'invalid-model-json' }
      const validTrace = isDigestOnlyTrace(parsed.tool_trace)
      const toolTrace = attempt.toolTrace ?? (validTrace ? parsed.tool_trace : [])
      if (parsed.tool_trace !== undefined && !validTrace) {
        output.runner_error = 'invalid-model-tool-trace'
      }
      const report = evaluateColdStartAttempt({
        model,
        oraclePassed: attempt.oraclePassed,
        output,
        pack,
        releaseLockDigest: lockDigest,
        runnerError: attempt.error,
        taskId,
        tokenCount: attempt.tokenCount,
        toolTrace,
      })
      reports.push(report)
    }
  }
  return reports
}

export function buildPrompt(
  pack,
  task,
  { lockDigest = 'unlocked', releaseLock, toolsEnabled = false } = {},
) {
  const safeTask = {
    id: task.id,
    input_fixture: {
      kind: task.input_fixture.kind,
      reference: task.input_fixture.reference,
    },
    operation: task.operation,
  }
  return [
    'You are a RE cold-start benchmark agent.',
    'Return one JSON object only. Do not use markdown fences.',
    'The host may provide only the explicitly allowed tools.',
    'Only task-contract allowed_tools may be requested.',
    'Request a tool with {"action":"tool","tool":"...","input":{...}}.',
    'After required_tools run, finish with {"action":"final","output":{}}.',
    'Do not repeat the same tool and input. Never claim an unexecuted tool.',
    'The host will apply security hard gates and will not trust claims.',
    `Release lock: ${lockDigest}`,
    `Budget: ${JSON.stringify(releaseLock?.budget ?? {})}`,
    `Tools enabled: ${toolsEnabled}`,
    `Task: ${JSON.stringify(safeTask)}`,
    `Agent protocol: ${pack.agent_protocol.schema}`,
    `Tool inputs: ${canonicalJson(taskToolInputs(pack, task))}`,
    `Task contract: ${canonicalJson(taskPromptContract(task))}`,
  ].join('\n')
}

function taskToolInputs(pack, task) {
  return Object.fromEntries(task.agent_contract.allowed_tools.map((tool) => [
    tool,
    pack.agent_protocol.tool_inputs[tool],
  ]))
}

function taskPromptContract(task) {
  return task.agent_contract
}

export function parseModelResponse(response) {
  if (typeof response !== 'string') return {}
  const trimmed = response.trim()
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed
  try {
    const value = JSON.parse(unfenced)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {}
  } catch {
    return {}
  }
}

export function validateAgentAction(pack, task, value) {
  if (!isPlainObject(value) || !isPlainObject(pack.agent_protocol) ||
      !isPlainObject(task.agent_contract)) {
    return 'invalid-model-action-schema'
  }
  const actionSchema = pack.agent_protocol.actions?.[value.action]
  if (!isPlainObject(actionSchema) || !closedShape(value, actionSchema)) {
    return 'invalid-model-action-schema'
  }
  if (value.action === 'tool') {
    if (typeof value.tool !== 'string' || !pack.allowed_tools.includes(value.tool)) {
      return 'disallowed-tool'
    }
    if (!task.agent_contract.allowed_tools.includes(value.tool)) {
      return 'disallowed-task-tool'
    }
    const inputSchema = pack.agent_protocol.tool_inputs?.[value.tool]
    if (!isPlainObject(value.input) || !closedTypedShape(value.input, inputSchema)) {
      return 'invalid-model-action-schema'
    }
    const fixedInput = task.agent_contract.fixed_tool_inputs?.[value.tool]
    if (fixedInput !== undefined &&
        canonicalJson(value.input) !== canonicalJson(fixedInput)) {
      return 'invalid-task-tool-input'
    }
    return null
  }
  if (value.action === 'final') {
    return isPlainObject(value.output) &&
      closedTypedShape(value.output, task.agent_contract.final_output)
      ? null
      : 'invalid-final-output-schema'
  }
  return 'invalid-model-action-schema'
}

async function callOllama({
  baseUrl,
  fetchImpl,
  modelName,
  prompt,
  releaseLock,
}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), releaseLock.budget.request_timeout_ms)
  let response
  let payload
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
      body: JSON.stringify({
        model: modelName,
        options: {
          num_predict: releaseLock.budget.max_output_tokens_per_call,
          temperature: releaseLock.runner.temperature,
        },
        prompt,
        stream: releaseLock.runner.stream,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`ollama-http-${response.status}`)
    payload = await response.json()
  } finally {
    clearTimeout(timeout)
  }
  return {
    outputTokenCount: payload.eval_count ?? 0,
    response: payload.response,
    tokenCount: (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0),
  }
}

async function runProbeAgent({ baseUrl, fetchImpl, modelName, prompt, releaseLock }) {
  try {
    const response = await callOllama({ baseUrl, fetchImpl, modelName, prompt, releaseLock })
    return {
      oraclePassed: false,
      parsed: parseModelResponse(response.response),
      tokenCount: response.tokenCount,
      toolTrace: [],
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.name : 'runner-error',
      oraclePassed: false,
      parsed: {},
      tokenCount: 0,
      toolTrace: [],
    }
  }
}

async function runToolAgent({
  baseUrl,
  fetchImpl,
  modelName,
  pack,
  prompt,
  task,
  releaseLock,
}) {
  let conversation = prompt
  let tokenCount = 0
  const toolTrace = []
  const toolResults = []
  let parsed = {}
  let error
  for (let sequence = 0; sequence < releaseLock.budget.max_tool_rounds; sequence += 1) {
    let response
    try {
      response = await callOllama({
        baseUrl,
        fetchImpl,
        modelName,
        prompt: conversation,
        releaseLock,
      })
    } catch (caught) {
      error = caught instanceof Error ? caught.name : 'runner-error'
      break
    }
    tokenCount += response.tokenCount
    if (response.outputTokenCount > releaseLock.budget.max_output_tokens_per_call ||
        tokenCount > releaseLock.budget.max_total_tokens) {
      error = 'token-budget-exceeded'
      break
    }
    parsed = parseModelResponse(response.response)
    const actionError = validateAgentAction(pack, task, parsed)
    if (actionError !== null) {
      error = actionError
      break
    }
    if (parsed.action === 'final') {
      return {
        oraclePassed: verifyTaskOutput(task, parsed.output, toolTrace, toolResults),
        parsed,
        tokenCount,
        toolTrace,
      }
    }
    let result
    const input = parsed.input
    try {
      result = await executeTool(parsed.tool, input, task)
    } catch (caught) {
      result = { error: caught instanceof Error ? caught.name : 'tool-error' }
    }
    toolResults.push({ result, tool: parsed.tool })
    toolTrace.push({
      input_digest: effectiveToolInputDigest(parsed.tool, input, task),
      output_digest: coldStartValueDigest(result),
      sequence,
      status: toolStatus(result),
      tool: parsed.tool,
    })
    conversation += `\nTool ${parsed.tool} result:\n${JSON.stringify(result)}`
  }
  return {
    error: error ?? 'tool-round-limit-exceeded',
    oraclePassed: false,
    parsed,
    tokenCount,
    toolTrace,
  }
}

async function executeTool(tool, input, task) {
  if (tool === 'source.read') {
    const path = input.path ?? task.input_fixture.reference
    return { content: await readRepoFile(path), path }
  }
  if (['re.check', 're.manifest', 're.run'].includes(tool)) {
    const path = input.path ?? task.input_fixture.reference
    return runCli(tool.slice(3), path)
  }
  if (tool === 're.module.resolve') {
    return resolveModuleTool(task)
  }
  if (tool === 're.patch') {
    return patchTool(task, input.patch)
  }
  throw new Error('unsupported-tool')
}

async function readRepoFile(path) {
  if (!isSafeRepoPath(path)) throw new Error('unsafe-repo-path')
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
}

function runCli(command, path) {
  if (!isSafeRepoPath(path)) return { error: 'unsafe-repo-path' }
  const cli = fileURLToPath(new URL('../cli/re.js', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [cli, command === 'check' ? 'check' : command, ...(command === 'check' ? ['--format', 'json'] : []), path],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' },
  )
  return {
    ...(result.status === 0 ? {} : { error: `exit-status-${result.status}` }),
    exit_status: result.status,
    stderr: result.stderr,
    stdout: parseJsonOrText(result.stdout),
  }
}

async function resolveModuleTool(task) {
  const source = JSON.parse(await readRepoFile(task.input_fixture.reference))
  const manifest = source.manifest
  const checkResult = validatePackageManifest(manifest)
  const fromModule = manifest.modules.find(({ name }) => name === task.oracle.from_module)
  const dependency = fromModule.interface.dependencies.find(
    ({ binding }) => binding === task.oracle.binding,
  )
  const resolved = resolveModuleImport(
    manifest,
    task.oracle.from_module,
    task.oracle.binding,
    task.oracle.export,
  )
  const target = manifest.modules.find(({ name }) => name === dependency.module)
  return {
    check_result: checkResult,
    dependency,
    module_interface: target.interface,
    package_manifest_digest: packageManifestDigest(manifest),
    resolved_symbol: resolved.reference,
    schema: 're.g6-cross-module-oracle@0.1.0',
  }
}

async function patchTool(task, patch) {
  const reference = await taskSourceReference(task)
  const source = await readRepoFile(reference)
  const parsed = parseExecutableSource(source, { file: reference })
  if (!parsed.ok) return parsed
  const checked = commit(createGraph(parsed.value, {
    check: (graph) => checkProgram(graph, { file: reference, registry }),
    uidFactory: deterministicUidFactory(),
  }))
  if (!checked.ok) return checked
  const before = serializeCanonicalGraph(checked.program)
  const result = applyStructuredPatch(checked.program, patch, {
    check: (graph) => checkProgram(graph, { file: reference, registry }),
  })
  return {
    result,
    revision: graphRevision(checked.program),
    unchanged_revision: serializeCanonicalGraph(checked.program) === before,
  }
}

function effectiveToolInputDigest(tool, input, task) {
  if (tool === 're.module.resolve') {
    return `sha256:${task.input_fixture.sha256}`
  }
  return coldStartValueDigest(input)
}

async function taskSourceReference(task) {
  if (task.input_fixture.kind !== 'canonical-graph-case') {
    return task.input_fixture.reference.split('#')[0]
  }
  const [corpusReference, caseId] = task.input_fixture.reference.split('#')
  if (!corpusReference || !caseId) throw new TypeError('invalid canonical graph reference')
  const corpus = JSON.parse(await readRepoFile(corpusReference))
  const graphCase = corpus.graph_cases?.find(({ id }) => id === caseId)
  if (graphCase === undefined ||
      graphCase.sha256 !== task.input_fixture.sha256 ||
      !isSafeRepoPath(graphCase.fixture)) {
    throw new TypeError('canonical graph fixture mismatch')
  }
  return graphCase.fixture
}

function verifyTaskOutput(task, output, toolTrace, toolResults) {
  if (!isPlainObject(output)) return false
  for (const requiredTool of task.agent_contract.required_tools) {
    if (!toolTrace.some(({ tool }) => tool === requiredTool)) return false
  }
  const requiredTool = task.agent_contract.required_tools.at(-1)
  const actual = [...toolResults].reverse().find(({ tool }) => tool === requiredTool)?.result
  if (!isPlainObject(actual) || !toolResultMatchesOracle(task, actual)) return false
  if (task.id === 'G6-001' || task.id === 'G6-002') {
    if (canonicalJson(output.check_result) !== canonicalJson(actual.stdout)) return false
    return task.id !== 'G6-002' ||
      canonicalJson(output.diagnostic) === canonicalJson(actual.stdout?.diagnostics?.[0])
  }
  if (task.id === 'G6-003') {
    return canonicalJson(output) === canonicalJson(actual) &&
      moduleResolutionMatchesOracle(actual, task.oracle.expected)
  }
  if (task.id === 'G6-004') {
    const diagnostic = actual.result?.diagnostics?.[0]
    return output.conflict_diagnostic?.code === task.oracle.diagnostic &&
      output.conflict_diagnostic?.code === diagnostic?.code &&
      output.unchanged_revision === actual.unchanged_revision
  }
  return false
}

function moduleResolutionMatchesOracle(actual, expected) {
  try {
    return actual.schema === 're.g6-cross-module-oracle@0.1.0' &&
      canonicalJson(actual.check_result) === canonicalJson({ ok: true }) &&
      actual.package_manifest_digest === expected.package_manifest_digest &&
      moduleInterfaceDigest(actual.module_interface) === expected.module_interface_digest &&
      canonicalJson(actual.dependency) === canonicalJson(expected.dependency) &&
      canonicalJson(actual.resolved_symbol) === canonicalJson(expected.resolved_symbol)
  } catch {
    return false
  }
}

function toolResultMatchesOracle(task, result) {
  if (Number.isSafeInteger(task.oracle.exit_status)) {
    return result.exit_status === task.oracle.exit_status
  }
  return result.error === undefined &&
    (result.exit_status === undefined || result.exit_status === 0)
}

function toolStatus(result) {
  return result.error === undefined &&
    (result.exit_status === undefined || result.exit_status === 0)
    ? 0
    : 1
}

function parseJsonOrText(value) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function isSafeRepoPath(path) {
  return typeof path === 'string' &&
    !path.startsWith('/') &&
    !path.split('/').includes('..')
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

async function loadPack() {
  return JSON.parse(await readFile(TASK_PACK_URL, 'utf8'))
}

async function taskPackDigest() {
  const { createHash } = await import('node:crypto')
  return `sha256:${createHash('sha256').update(await readFile(TASK_PACK_URL)).digest('hex')}`
}

function assertBindings(bindings, pack) {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new TypeError('Ollama model bindings are required')
  }
  for (const model of pack.models) {
    if (typeof bindings[model] !== 'string' || bindings[model].length === 0) {
      throw new TypeError(`missing Ollama binding for ${model}`)
    }
  }
}

function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Ollama runner requires fetch')
  }
}

function isDigestOnlyTrace(trace) {
  if (!Array.isArray(trace)) return false
  return trace.every((event, index) =>
    isPlainObject(event) &&
    JSON.stringify(Object.keys(event).sort()) === JSON.stringify(TRACE_FIELDS) &&
    event.sequence === index &&
    typeof event.tool === 'string' &&
    Number.isSafeInteger(event.status) &&
    DIGEST.test(event.input_digest) &&
    DIGEST.test(event.output_digest)
  )
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function closedShape(value, schema) {
  if (!isPlainObject(schema) || !Array.isArray(schema.required)) return false
  const fields = Object.keys(value)
  const allowed = isPlainObject(schema.properties)
    ? Object.keys(schema.properties)
    : schema.required
  return schema.required.every((field) => Object.hasOwn(value, field)) &&
    (schema.additional_properties !== false ||
      fields.every((field) => allowed.includes(field)))
}

function closedTypedShape(value, schema) {
  if (!isPlainObject(value) || !isPlainObject(schema) ||
      !isPlainObject(schema.properties) || !closedShape(value, schema)) {
    return false
  }
  return Object.entries(value).every(([field, fieldValue]) =>
    matchesType(fieldValue, schema.properties[field]),
  )
}

function matchesType(value, type) {
  if (type === 'object') return isPlainObject(value)
  return typeof value === type
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bindings = parseBindings(process.argv.slice(2))
  const reports = await runOllamaColdStart({ modelBindings: bindings })
  for (const report of reports) process.stdout.write(`${JSON.stringify(report)}\n`)
}

function parseBindings(arguments_) {
  const bindings = {}
  for (const argument of arguments_) {
    const match = /^--(model-[abc])=(.+)$/.exec(argument)
    if (match === null) {
      throw new TypeError(
        'usage: cold-start-runner --model-a=MODEL --model-b=MODEL --model-c=MODEL',
      )
    }
    bindings[match[1]] = match[2]
  }
  return bindings
}
