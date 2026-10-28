import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { parseGrammarCandidate } from './grammar-bakeoff.js'
import { lowerModuleSurface } from './module-surface.js'
import { parseProgram } from './parser.js'

const DEFAULT_ITERATIONS = 1_000_000
const DEFAULT_SEED = 0x52455f32
const FUZZ_SEED_CASE_IDS = Object.freeze([
  'PAIR-HELLO-S2',
  'PAIR-NUMERIC-S2',
])
const PRINTABLE = Object.freeze(Array.from(
  { length: 0x7e - 0x21 + 1 },
  (_, index) => String.fromCodePoint(0x21 + index),
))

export async function runGrammarFuzzGate({
  enforceTiming = true,
  iterations = DEFAULT_ITERATIONS,
  lengthProbe = true,
  onProgress = () => {},
  seed = DEFAULT_SEED,
} = {}) {
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new TypeError('grammar fuzz iterations must be a positive integer')
  }
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError('grammar fuzz seed must be an integer')
  }

  const [corpus, moduleCorpus, moduleContractCorpus] = await Promise.all([
    readJsonFixture('../../test/fixtures/grammar-corpus.json'),
    readJsonFixture('../../test/fixtures/module-source-surface-corpus.json'),
    readJsonFixture('../../test/fixtures/module-contract-corpus.json'),
  ])
  const seedCases = FUZZ_SEED_CASE_IDS.map((id) => {
    const fixture = corpus.cases.find((entry) => entry.id === id)
    if (fixture === undefined) throw new Error(`missing ${id} fuzz seed`)
    const parse = (source, file) =>
      parseGrammarCandidate(source, { file, grammar: 'S2' })
    const parsed = parse(fixture.input, `<seed:${id}>`)
    if (!parsed.ok) throw new Error(`${id} is not a valid S2 seed`)
    return {
      baselineGraph: JSON.stringify(normalizeFuzzValue(parsed.value)),
      fixture,
      parse,
      parser: 'grammar-candidate:S2',
    }
  })
  const moduleFixture = moduleCorpus.cases.find(({ id }) => id === 'SRC-001')
  if (moduleFixture === undefined) throw new Error('missing SRC-001 fuzz seed')
  const parseModule = (source, file) =>
    lowerModuleSurface(source, moduleContractCorpus.manifest, { file })
  const parsedModule = parseModule(moduleFixture.source, '<seed:SRC-001>')
  if (!parsedModule.ok) throw new Error('SRC-001 is not a valid module seed')
  seedCases.push({
    baselineGraph: JSON.stringify(normalizeFuzzValue(parsedModule.value)),
    fixture: {
      id: moduleFixture.id,
      input: moduleFixture.source,
    },
    parse: parseModule,
    parser: 'module-surface',
  })
  const argsSource = await readTextFixture('../../examples/args-check.re')
  const parseProduction = (source, file) => parseProgram(source, { file })
  const parsedProduction = parseProduction(argsSource, '<seed:ARGS-CHECK>')
  if (!parsedProduction.ok) throw new Error('ARGS-CHECK is not a valid production seed')
  seedCases.push({
    baselineGraph: JSON.stringify(normalizeFuzzValue(parsedProduction.value)),
    fixture: {
      id: 'ARGS-CHECK',
      input: argsSource,
    },
    parse: parseProduction,
    parser: 'production:parseProgram',
  })
  const allocations = allocateIterations(iterations, seedCases.length)
  const sourceDigest = sha256(seedCases
    .map(({ fixture, parser }) => `${parser}\0${fixture.id}\0${fixture.input}`)
    .join('\0'))
  const outcomeDigest = createHash('sha256')
  const checkpointCases = checkpointCounts(iterations)
  const checkpoints = []
  const seedReports = []
  let acceptedChanged = 0
  let crashes = 0
  let nondeterministic = 0
  let rejected = 0
  let wrongGraph = 0
  let completed = 0
  let previousCases = 0
  let previousTime = performance.now()

  for (let seedIndex = 0; seedIndex < seedCases.length; seedIndex += 1) {
    const { baselineGraph, fixture, parse, parser } = seedCases[seedIndex]
    const allocation = allocations[seedIndex]
    const localDigest = createHash('sha256')
    const local = {
      accepted_changed: 0,
      crash_count: 0,
      id: fixture.id,
      iterations: allocation,
      mutation_offsets: grammarMutationOffsets(fixture.input).length,
      nondeterministic_count: 0,
      parser,
      rejected: 0,
      seed: deriveSeed(seed, seedIndex),
      source_digest: `sha256:${sha256(fixture.input)}`,
      wrong_graph_count: 0,
    }

    for (const mutation of grammarPairMutations(fixture.input, {
      count: allocation,
      seed: local.seed,
    })) {
      let result
      let signature
      try {
        result = parse(
          mutation.source,
          `fuzz:${fixture.id}:${mutation.id}`,
        )
      } catch (error) {
        crashes += 1
        local.crash_count += 1
        signature = `throw:${error?.name}`
        localDigest.update(`${mutation.descriptor}:${signature}\n`)
        outcomeDigest.update(`${fixture.id}:${mutation.descriptor}:${signature}\n`)
      }

      if (result !== undefined) {
        signature = resultSignature(result)
        localDigest.update(`${mutation.descriptor}:${signature}\n`)
        outcomeDigest.update(`${fixture.id}:${mutation.descriptor}:${signature}\n`)
        if (result.ok) {
          if (JSON.stringify(normalizeFuzzValue(result.value)) === baselineGraph) {
            wrongGraph += 1
            local.wrong_graph_count += 1
          } else {
            acceptedChanged += 1
            local.accepted_changed += 1
          }
        } else {
          rejected += 1
          local.rejected += 1
        }

        if ((completed + 1) % 10_000 === 0) {
          const replay = parse(
            mutation.source,
            `fuzz:${fixture.id}:${mutation.id}`,
          )
          if (resultSignature(replay) !== signature) {
            nondeterministic += 1
            local.nondeterministic_count += 1
          }
        }
      }

      completed += 1
      if (checkpointCases.has(completed)) {
        const now = performance.now()
        const elapsedMs = now - previousTime
        const cases = completed - previousCases
        const checkpoint = {
          cases: completed,
          cases_per_second: rounded(cases / (elapsedMs / 1000)),
          segment_ms: rounded(elapsedMs),
        }
        checkpoints.push(checkpoint)
        onProgress(checkpoint)
        previousCases = completed
        previousTime = now
      }
    }
    local.outcome_digest = `sha256:${localDigest.digest('hex')}`
    seedReports.push(local)
  }

  const countRateRatio = rateRatio(checkpoints)
  const length = lengthProbe
    ? {
        near_linear: true,
        seeds: seedCases.map(({ baselineGraph, fixture, parse, parser }) => ({
          id: fixture.id,
          parser,
          ...runLengthProbe(fixture.input, baselineGraph, parse),
        })),
      }
    : null
  if (length !== null) {
    length.near_linear = length.seeds.every((entry) => entry.near_linear)
  }
  const nearLinear =
    countRateRatio <= 3 &&
    (length === null || length.near_linear)
  const report = {
    accepted_changed: acceptedChanged,
    candidate: 'S2',
    checkpoint_rate_ratio: rounded(countRateRatio),
    checkpoints,
    crash_count: crashes,
    iterations,
    length_probe: length,
    mutation: 'two-distinct-grammar-byte-replacements',
    mutation_offsets: seedReports.reduce(
      (sum, entry) => sum + entry.mutation_offsets,
      0,
    ),
    near_linear: nearLinear,
    nondeterministic_count: nondeterministic,
    outcome_digest: `sha256:${outcomeDigest.digest('hex')}`,
    rejected,
    schema: 're.grammar-fuzz-report@0.3.0',
    seed,
    seed_cases: seedReports,
    source_digest: `sha256:${sourceDigest}`,
    wrong_graph_count: wrongGraph,
  }
  report.ok =
    crashes === 0 &&
    nondeterministic === 0 &&
    wrongGraph === 0 &&
    (!enforceTiming || nearLinear)
  return report
}

export function verifyGrammarFuzzBaseline(report, baseline) {
  const fields = [
    'accepted_changed',
    'candidate',
    'crash_count',
    'iterations',
    'mutation',
    'nondeterministic_count',
    'outcome_digest',
    'rejected',
    'seed',
    'seed_cases',
    'source_digest',
    'mutation_offsets',
    'wrong_graph_count',
  ]
  return (
    baseline?.schema === 're.grammar-fuzz-baseline@0.5.0' &&
    fields.every((field) => equalBaselineField(report[field], baseline[field]))
  )
}

function allocateIterations(iterations, count) {
  const base = Math.floor(iterations / count)
  const remainder = iterations % count
  return Array.from(
    { length: count },
    (_, index) => base + (index < remainder ? 1 : 0),
  )
}

function deriveSeed(seed, index) {
  return (seed + Math.imul(index, 0x9e3779b9)) >>> 0
}

function equalBaselineField(actual, expected) {
  if (
    actual !== null &&
    typeof actual === 'object' &&
    expected !== null &&
    typeof expected === 'object'
  ) {
    return JSON.stringify(actual) === JSON.stringify(expected)
  }
  return Object.is(actual, expected)
}

function* grammarPairMutations(source, { count, seed }) {
  if (count === 0) return
  const positions = grammarMutationOffsets(source)
  const pairs = []
  for (let left = 0; left < positions.length; left += 1) {
    for (let right = left + 1; right < positions.length; right += 1) {
      pairs.push([positions[left], positions[right]])
    }
  }
  shuffle(pairs, seed)

  let id = 0
  for (const [left, right] of pairs) {
    const leftChoices = rotatedChoices(source[left], seed + left)
    const rightChoices = rotatedChoices(source[right], seed + right)
    for (const leftReplacement of leftChoices) {
      for (const rightReplacement of rightChoices) {
        yield {
          descriptor: `${left}:${leftReplacement.charCodeAt(0)}-${right}:${rightReplacement.charCodeAt(0)}`,
          id,
          source:
            source.slice(0, left) +
            leftReplacement +
            source.slice(left + 1, right) +
            rightReplacement +
            source.slice(right + 1),
        }
        id += 1
        if (id === count) return
      }
    }
  }
  throw new RangeError(
    `grammar fuzz request exceeds ${id} unique grammar mutations`,
  )
}

function grammarMutationOffsets(source) {
  const offsets = []
  let comment = false
  let escaped = false
  let string = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (comment) {
      if (character === '\n') comment = false
      continue
    }
    if (string) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') string = false
      continue
    }
    if (source.startsWith('//', index)) {
      comment = true
      index += 1
      continue
    }
    if (character === '"') {
      string = true
      continue
    }
    if (![' ', '\t', '\n'].includes(character)) offsets.push(index)
  }
  return offsets
}

function rotatedChoices(original, seed) {
  const choices = PRINTABLE.filter((character) => character !== original)
  const offset = (seed >>> 0) % choices.length
  return [...choices.slice(offset), ...choices.slice(0, offset)]
}

function shuffle(values, seed) {
  const next = xorshift32(seed)
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = next() % (index + 1)
    const temporary = values[index]
    values[index] = values[target]
    values[target] = temporary
  }
}

function xorshift32(seed) {
  let state = seed >>> 0
  if (state === 0) state = 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}

function checkpointCounts(iterations) {
  return new Set([
    Math.max(1, Math.floor(iterations / 4)),
    Math.max(1, Math.floor(iterations / 2)),
    iterations,
  ])
}

function rateRatio(checkpoints) {
  const rates = checkpoints.map(({ cases_per_second: rate }) => rate)
  return Math.max(...rates) / Math.min(...rates)
}

function runLengthProbe(source, baselineGraph, parse) {
  const sizes = [1024, 4096, 16_384, 65_536]
  const samples = []
  for (const size of sizes) {
    const headerEnd = source.indexOf('\n') + 1
    const candidate =
      source.slice(0, headerEnd) +
      `// ${'x'.repeat(size)}\n` +
      source.slice(headerEnd)
    const repeats = Math.max(16, Math.floor(8_000_000 / candidate.length))
    parse(candidate, '<length-probe>')
    const started = performance.now()
    for (let iteration = 0; iteration < repeats; iteration += 1) {
      const result = parse(candidate, '<length-probe>')
      if (
        !result.ok ||
        JSON.stringify(normalizeFuzzValue(result.value)) !== baselineGraph
      ) {
        throw new Error('grammar length probe changed the normalized graph')
      }
    }
    const elapsedMs = performance.now() - started
    samples.push({
      bytes: Buffer.byteLength(candidate),
      ns_per_byte: rounded((elapsedMs * 1_000_000) / (candidate.length * repeats)),
      repeats,
    })
  }
  const priorMaximum = Math.max(...samples.slice(0, -1).map(({ ns_per_byte: rate }) => rate))
  const largestRate = samples.at(-1).ns_per_byte
  return {
    largest_to_prior_rate: rounded(largestRate / priorMaximum),
    near_linear: largestRate <= priorMaximum * 2.5,
    samples,
  }
}

function resultSignature(result) {
  if (result.ok) {
    return `ok:${JSON.stringify(normalizeFuzzValue(result.value))}`
  }
  const diagnostic = result.diagnostics[0]
  return `error:${JSON.stringify({
    actual: diagnostic.actual ?? null,
    binding: diagnostic.binding ?? null,
    byte_end: diagnostic.byte_end ?? null,
    byte_start: diagnostic.byte_start ?? null,
    code: diagnostic.code,
    column: diagnostic.column ?? null,
    end_column: diagnostic.end_column ?? null,
    end_line: diagnostic.end_line ?? null,
    expected: diagnostic.expected ?? null,
    export: diagnostic.export ?? null,
    line: diagnostic.line ?? null,
    phase: diagnostic.phase ?? null,
    reason: diagnostic.reason ?? null,
    rule: diagnostic.rule ?? null,
  })}`
}

export function normalizeFuzzValue(value) {
  if (Array.isArray(value)) return value.map(normalizeFuzzValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'location')
      .map(([key, entry]) => [key, normalizeFuzzValue(entry)]),
  )
}

async function readJsonFixture(relativeUrl) {
  return JSON.parse(await readFile(new URL(relativeUrl, import.meta.url), 'utf8'))
}

async function readTextFixture(relativeUrl) {
  return readFile(new URL(relativeUrl, import.meta.url), 'utf8')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function rounded(value) {
  return Math.round(value * 1000) / 1000
}

async function main() {
  const iterations = parseIterations(process.argv.slice(2))
  const report = await runGrammarFuzzGate({
    iterations,
    onProgress: (checkpoint) => {
      process.stderr.write(
        `grammar-fuzz ${checkpoint.cases}/${iterations} ${checkpoint.cases_per_second} cases/s\n`,
      )
    },
  })
  if (iterations === DEFAULT_ITERATIONS) {
    const baseline = JSON.parse(await readFile(
      new URL('../../test/fixtures/grammar-fuzz-baseline.json', import.meta.url),
      'utf8',
    ))
    report.baseline_match = verifyGrammarFuzzBaseline(report, baseline)
    report.ok &&= report.baseline_match
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.exitCode = report.ok ? 0 : 1
}

function parseIterations(arguments_) {
  if (arguments_.length === 0) return DEFAULT_ITERATIONS
  if (arguments_.length !== 2 || arguments_[0] !== '--iterations') {
    throw new TypeError('usage: grammar-fuzz-gate [--iterations N]')
  }
  const iterations = Number(arguments_[1])
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new TypeError('grammar fuzz iterations must be a positive integer')
  }
  return iterations
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
