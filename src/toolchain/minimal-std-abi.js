import { createHash } from 'node:crypto'

import {
  moduleInterfaceDigest,
} from './module-contract.js'
import {
  typeDeclarationDigest,
  validateTypeDeclaration,
} from './type-contract.js'

export const MINIMAL_STD_ABI_CORPUS_SCHEMA =
  're.minimal-std-abi-corpus@0.1.0'
export const MINIMAL_STD_ABI_REPORT_SCHEMA =
  're.minimal-std-abi-report@0.1.0'
export const MINIMAL_STD_ABI_PROFILE =
  're.minimal-std-abi@0.1.0'
export const STD_OPERATION_SCHEMA =
  're.std-operation@0.1.0'
export const STD_PACKAGE_MANIFEST_SCHEMA =
  're.std-package-manifest@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const NAME = /^[a-z][a-z0-9_]*$/u
const MODULE = /^std\.[a-z][a-z0-9_]*$/u
const PRIMITIVES = new Set(['bool', 'bytes', 'int', 'text.utf8', 'unit'])
const CORPUS_FIELDS = ['modules', 'package', 'schema']
const MODULE_CORPUS_FIELDS = ['module', 'operations', 'types']
const OPERATION_FIELDS = [
  'error_variants',
  'kind',
  'module',
  'name',
  'parameters',
  'result',
  'schema',
  'type_parameters',
]
const PARAMETER_FIELDS = ['name', 'type']
const REPORT_FIELDS = [
  'corpus_digest',
  'modules',
  'package_digest',
  'package_manifest',
  'profile',
  'report_digest',
  'schema',
]
const REPORT_MODULE_FIELDS = [
  'interface',
  'interface_digest',
  'module',
  'operations',
  'types',
]
const REPORT_OPERATION_FIELDS = [...OPERATION_FIELDS, 'contract_digest']
const REPORT_TYPE_FIELDS = ['declaration', 'declaration_digest']
const PACKAGE_MANIFEST_FIELDS = ['modules', 'package', 'schema']
const PACKAGE_MODULE_FIELDS = ['interface_digest', 'module']

const bytesErrorDeclaration = Object.freeze({
  body: Object.freeze({
    kind: 'sum',
    variants: Object.freeze([
      Object.freeze({ name: 'invalid_utf8' }),
    ]),
  }),
  module: 'std.bytes',
  name: 'decode_error',
  parameters: Object.freeze([]),
  schema: 're.type-declaration@0.1.0',
})
const bytesErrorDigest = typeDeclarationDigest(bytesErrorDeclaration)

const primitive = (name) => Object.freeze({ kind: 'primitive', name })
const parameter = (name) => Object.freeze({ kind: 'parameter', name })
const list = (element) => Object.freeze({ element, kind: 'list' })
const result = (ok, error) => Object.freeze({ error, kind: 'result', ok })
const declared = (declaration_digest, arguments_) => Object.freeze({
  arguments: Object.freeze(arguments_),
  declaration_digest,
  kind: 'declared',
})
const operation = ({
  error_variants = [],
  module,
  name,
  parameters,
  result: resultType,
  type_parameters = [],
}) => Object.freeze({
  error_variants: Object.freeze(error_variants),
  kind: 'pure',
  module,
  name,
  parameters: Object.freeze(parameters.map(([parameterName, type]) =>
    Object.freeze({ name: parameterName, type }))),
  result: resultType,
  schema: STD_OPERATION_SCHEMA,
  type_parameters: Object.freeze(type_parameters),
})

export const MINIMAL_STD_ABI_MODULES = Object.freeze([
  Object.freeze({
    module: 'std.bytes',
    operations: Object.freeze([
      operation({
        module: 'std.bytes',
        name: 'byte_count',
        parameters: [['value', primitive('bytes')]],
        result: primitive('int'),
      }),
      operation({
        module: 'std.bytes',
        name: 'concat',
        parameters: [
          ['left', primitive('bytes')],
          ['right', primitive('bytes')],
        ],
        result: primitive('bytes'),
      }),
      operation({
        error_variants: ['invalid_utf8'],
        module: 'std.bytes',
        name: 'decode_utf8',
        parameters: [['value', primitive('bytes')]],
        result: result(
          primitive('text.utf8'),
          declared(bytesErrorDigest, []),
        ),
      }),
    ]),
    types: Object.freeze([bytesErrorDeclaration]),
  }),
  Object.freeze({
    module: 'std.list',
    operations: Object.freeze([
      operation({
        module: 'std.list',
        name: 'append',
        parameters: [
          ['value', parameter('t')],
          ['values', list(parameter('t'))],
        ],
        result: list(parameter('t')),
        type_parameters: ['t'],
      }),
      operation({
        module: 'std.list',
        name: 'concat',
        parameters: [
          ['left', list(parameter('t'))],
          ['right', list(parameter('t'))],
        ],
        result: list(parameter('t')),
        type_parameters: ['t'],
      }),
      operation({
        module: 'std.list',
        name: 'length',
        parameters: [['values', list(parameter('t'))]],
        result: primitive('int'),
        type_parameters: ['t'],
      }),
    ]),
    types: Object.freeze([]),
  }),
  Object.freeze({
    module: 'std.result',
    operations: Object.freeze([
      operation({
        module: 'std.result',
        name: 'is_err',
        parameters: [[
          'value',
          result(parameter('t'), parameter('e')),
        ]],
        result: primitive('bool'),
        type_parameters: ['t', 'e'],
      }),
      operation({
        module: 'std.result',
        name: 'is_ok',
        parameters: [[
          'value',
          result(parameter('t'), parameter('e')),
        ]],
        result: primitive('bool'),
        type_parameters: ['t', 'e'],
      }),
    ]),
    types: Object.freeze([]),
  }),
  Object.freeze({
    module: 'std.text',
    operations: Object.freeze([
      operation({
        module: 'std.text',
        name: 'concat',
        parameters: [
          ['left', primitive('text.utf8')],
          ['right', primitive('text.utf8')],
        ],
        result: primitive('text.utf8'),
      }),
      operation({
        module: 'std.text',
        name: 'encode_utf8',
        parameters: [['value', primitive('text.utf8')]],
        result: primitive('bytes'),
      }),
      operation({
        module: 'std.text',
        name: 'scalar_count',
        parameters: [['value', primitive('text.utf8')]],
        result: primitive('int'),
      }),
    ]),
    types: Object.freeze([]),
  }),
])

export function validateMinimalStdAbiCorpus(corpus) {
  try {
    exactFields(corpus, CORPUS_FIELDS, 'corpus')
    if (corpus.schema !== MINIMAL_STD_ABI_CORPUS_SCHEMA
      || corpus.package !== 'std') {
      fail('minimal-std-abi-corpus-schema-mismatch')
    }
    const modules = indexBy(corpus.modules, 'module', 'module-set')
    if (!sameSet(modules.keys(), MINIMAL_STD_ABI_MODULES.map(({ module }) => module))) {
      fail('minimal-std-abi-module-set-mismatch')
    }
    for (const expected of MINIMAL_STD_ABI_MODULES) {
      const actual = modules.get(expected.module)
      exactFields(actual, MODULE_CORPUS_FIELDS, 'module')
      validateModule(actual, expected)
    }
    return { ok: true }
  } catch (error) {
    return rejected(error)
  }
}

export function createMinimalStdAbiReport(corpus) {
  const validated = validateMinimalStdAbiCorpus(corpus)
  if (!validated.ok) return validated
  try {
    const modules = MINIMAL_STD_ABI_MODULES.map(buildModuleReport)
    const packageManifest = {
      modules: modules.map(({ interface_digest, module }) => ({
        interface_digest,
        module,
      })),
      package: 'std',
      schema: STD_PACKAGE_MANIFEST_SCHEMA,
    }
    const content = {
      corpus_digest: digest(normalizeCorpus(corpus)),
      modules,
      package_digest: digest(packageManifest),
      package_manifest: packageManifest,
      profile: MINIMAL_STD_ABI_PROFILE,
      schema: MINIMAL_STD_ABI_REPORT_SCHEMA,
    }
    const report = {
      ...content,
      report_digest: minimalStdAbiReportDigest(content),
    }
    return { ok: true, value: report }
  } catch (error) {
    return rejected(error)
  }
}

export function minimalStdPackageManifest() {
  const modules = MINIMAL_STD_ABI_MODULES.map(buildModuleReport)
  return {
    modules: modules.map(({ interface_digest, module }) => ({
      interface_digest,
      module,
    })),
    package: 'std',
    schema: STD_PACKAGE_MANIFEST_SCHEMA,
  }
}

export function minimalStdPackageDigest() {
  return digest(minimalStdPackageManifest())
}

export function minimalStdModuleAuthority(module) {
  const expected = MINIMAL_STD_ABI_MODULES.find(
    (candidate) => candidate.module === module,
  )
  if (expected === undefined) return null
  const report = buildModuleReport(expected)
  return structuredClone({
    interface: report.interface,
    interface_digest: report.interface_digest,
    module: report.module,
  })
}

export function verifyMinimalStdAbiReport(report, corpus) {
  const validated = validateReportShape(report)
  if (!validated.ok) return validated
  const expected = createMinimalStdAbiReport(corpus)
  if (!expected.ok) return expected
  if (!canonicalEqual(report, expected.value)) {
    return rejected('minimal-std-abi-report-authority-mismatch')
  }
  return { ok: true }
}

export function minimalStdAbiReportDigest(report) {
  if (!plainObject(report)) throw new TypeError('invalid minimal std ABI report')
  const { report_digest: ignored, ...content } = report
  return digest(content)
}

function validateModule(actual, expected) {
  if (actual.module !== expected.module) {
    fail('minimal-std-abi-module-contract-mismatch')
  }
  const types = indexBy(actual.types, 'name', 'type-set')
  if (!sameSet(types.keys(), expected.types.map(({ name }) => name))) {
    fail('minimal-std-abi-type-set-mismatch')
  }
  for (const declaration of expected.types) {
    const candidate = types.get(declaration.name)
    const validation = validateTypeDeclaration(candidate)
    if (!validation.ok
      || typeDeclarationDigest(candidate) !== typeDeclarationDigest(declaration)
      || !canonicalEqual(candidate, declaration)) {
      fail('minimal-std-abi-type-contract-mismatch')
    }
  }

  const operations = indexBy(actual.operations, 'name', 'operation-set')
  if (!sameSet(operations.keys(), expected.operations.map(({ name }) => name))) {
    fail('minimal-std-abi-operation-set-mismatch')
  }
  const declarations = new Map(expected.types.map((declaration) => [
    typeDeclarationDigest(declaration),
    declaration,
  ]))
  for (const expectedOperation of expected.operations) {
    const candidate = operations.get(expectedOperation.name)
    const normalized = normalizeOperation(candidate, declarations)
    if (!canonicalEqual(normalized, expectedOperation)) {
      fail('minimal-std-abi-operation-contract-mismatch')
    }
  }
}

function normalizeOperation(input, declarations) {
  exactFields(input, OPERATION_FIELDS, 'operation')
  if (input.schema !== STD_OPERATION_SCHEMA
    || input.kind !== 'pure'
    || !MODULE.test(input.module)
    || !NAME.test(input.name)) {
    fail('minimal-std-abi-operation-contract-mismatch')
  }
  if (!Array.isArray(input.type_parameters)
    || input.type_parameters.some((name) => !NAME.test(name))
    || new Set(input.type_parameters).size !== input.type_parameters.length) {
    fail('minimal-std-abi-operation-contract-mismatch')
  }
  const typeParameters = new Set(input.type_parameters)
  const parameters = indexBy(input.parameters, 'name', 'parameter-set')
  const normalizedParameters = [...parameters.values()]
    .map((parameterEntry) => {
      exactFields(parameterEntry, PARAMETER_FIELDS, 'parameter')
      if (!NAME.test(parameterEntry.name)) {
        fail('minimal-std-abi-operation-contract-mismatch')
      }
      return {
        name: parameterEntry.name,
        type: normalizeAbiType(parameterEntry.type, typeParameters),
      }
    })
    .sort((left, right) => compareText(left.name, right.name))
  if (!Array.isArray(input.error_variants)
    || input.error_variants.some((name) => !NAME.test(name))
    || new Set(input.error_variants).size !== input.error_variants.length) {
    fail('minimal-std-abi-operation-contract-mismatch')
  }
  const resultType = normalizeAbiType(input.result, typeParameters)
  validateErrorVariants(input.error_variants, resultType, declarations)
  return {
    error_variants: [...input.error_variants].sort(compareText),
    kind: 'pure',
    module: input.module,
    name: input.name,
    parameters: normalizedParameters,
    result: resultType,
    schema: STD_OPERATION_SCHEMA,
    type_parameters: [...input.type_parameters],
  }
}

function normalizeAbiType(input, parameters, depth = 0) {
  if (depth > 128 || !plainObject(input)) {
    fail('minimal-std-abi-operation-contract-mismatch')
  }
  if (input.kind === 'primitive') {
    exactFields(input, ['kind', 'name'], 'operation-type')
    if (!PRIMITIVES.has(input.name)) {
      fail('minimal-std-abi-operation-contract-mismatch')
    }
    return { kind: 'primitive', name: input.name }
  }
  if (input.kind === 'parameter') {
    exactFields(input, ['kind', 'name'], 'operation-type')
    if (!parameters.has(input.name)) {
      fail('minimal-std-abi-operation-contract-mismatch')
    }
    return { kind: 'parameter', name: input.name }
  }
  if (input.kind === 'list') {
    exactFields(input, ['element', 'kind'], 'operation-type')
    return {
      element: normalizeAbiType(input.element, parameters, depth + 1),
      kind: 'list',
    }
  }
  if (input.kind === 'result') {
    exactFields(input, ['error', 'kind', 'ok'], 'operation-type')
    return {
      error: normalizeAbiType(input.error, parameters, depth + 1),
      kind: 'result',
      ok: normalizeAbiType(input.ok, parameters, depth + 1),
    }
  }
  if (input.kind === 'declared') {
    exactFields(
      input,
      ['arguments', 'declaration_digest', 'kind'],
      'operation-type',
    )
    if (!DIGEST.test(input.declaration_digest)
      || !Array.isArray(input.arguments)) {
      fail('minimal-std-abi-operation-contract-mismatch')
    }
    return {
      arguments: input.arguments.map((argument) =>
        normalizeAbiType(argument, parameters, depth + 1)),
      declaration_digest: input.declaration_digest,
      kind: 'declared',
    }
  }
  fail('minimal-std-abi-operation-contract-mismatch')
}

function validateErrorVariants(variants, resultType, declarations) {
  if (variants.length === 0) return
  if (resultType.kind !== 'result'
    || resultType.error.kind !== 'declared'
    || resultType.error.arguments.length !== 0) {
    fail('minimal-std-abi-operation-contract-mismatch')
  }
  const declaration = declarations.get(resultType.error.declaration_digest)
  if (declaration?.body?.kind !== 'sum') {
    fail('minimal-std-abi-operation-contract-mismatch')
  }
  const declaredVariants = declaration.body.variants.map(({ name }) => name)
  if (!canonicalEqual([...variants].sort(compareText), declaredVariants)) {
    fail('minimal-std-abi-operation-contract-mismatch')
  }
}

function buildModuleReport(moduleDefinition) {
  const types = moduleDefinition.types.map((declaration) => ({
    declaration: structuredClone(declaration),
    declaration_digest: typeDeclarationDigest(declaration),
  }))
  const declarations = new Map(types.map(({ declaration, declaration_digest }) => [
    declaration_digest,
    declaration,
  ]))
  const operations = moduleDefinition.operations.map((entry) => {
    const normalized = normalizeOperation(entry, declarations)
    return {
      ...normalized,
      contract_digest: digest(normalized),
    }
  })
  const interface_ = {
    dependencies: [],
    exports: [
      ...types.map(({ declaration, declaration_digest }) => ({
        contract_digest: declaration_digest,
        kind: 'type',
        name: declaration.name,
      })),
      ...operations.map(({ contract_digest, name }) => ({
        contract_digest,
        kind: 'function',
        name,
      })),
    ].sort((left, right) => compareText(left.name, right.name)),
    module: moduleDefinition.module,
    schema: 're.module-interface@0.1.0',
  }
  return {
    interface: interface_,
    interface_digest: moduleInterfaceDigest(interface_),
    module: moduleDefinition.module,
    operations,
    types,
  }
}

function validateReportShape(report) {
  try {
    exactFields(report, REPORT_FIELDS, 'report')
    if (report.schema !== MINIMAL_STD_ABI_REPORT_SCHEMA
      || report.profile !== MINIMAL_STD_ABI_PROFILE
      || !DIGEST.test(report.corpus_digest)
      || !DIGEST.test(report.package_digest)
      || !DIGEST.test(report.report_digest)
      || report.report_digest !== minimalStdAbiReportDigest(report)) {
      fail('minimal-std-abi-report-digest-mismatch')
    }
    exactFields(report.package_manifest, PACKAGE_MANIFEST_FIELDS, 'package-manifest')
    if (report.package_manifest.schema !== STD_PACKAGE_MANIFEST_SCHEMA
      || report.package_manifest.package !== 'std'
      || report.package_digest !== digest(report.package_manifest)) {
      fail('minimal-std-abi-package-manifest-mismatch')
    }
    const manifestModules = indexBy(
      report.package_manifest.modules,
      'module',
      'package-module-set',
    )
    const modules = indexBy(report.modules, 'module', 'report-module-set')
    if (!sameSet(modules.keys(), MINIMAL_STD_ABI_MODULES.map(({ module }) => module))
      || !sameSet(
        manifestModules.keys(),
        MINIMAL_STD_ABI_MODULES.map(({ module }) => module),
      )) {
      fail('minimal-std-abi-report-module-set-mismatch')
    }
    for (const [moduleName, module] of modules) {
      exactFields(module, REPORT_MODULE_FIELDS, 'report-module')
      if (module.module !== moduleName
        || !Array.isArray(module.operations)
        || !Array.isArray(module.types)
        || !plainObject(module.interface)
        || module.interface.module !== moduleName) {
        fail('minimal-std-abi-report-module-invalid')
      }
      if (!DIGEST.test(module.interface_digest)
        || module.interface_digest !== moduleInterfaceDigest(module.interface)) {
        fail('minimal-std-abi-module-interface-mismatch')
      }
      const manifestModule = manifestModules.get(moduleName)
      exactFields(manifestModule, PACKAGE_MODULE_FIELDS, 'package-module')
      if (manifestModule.interface_digest !== module.interface_digest) {
        fail('minimal-std-abi-package-manifest-mismatch')
      }
      for (const operationEntry of module.operations) {
        exactFields(operationEntry, REPORT_OPERATION_FIELDS, 'report-operation')
        const { contract_digest, ...contract } = operationEntry
        if (!DIGEST.test(contract_digest)
          || contract_digest !== digest(contract)) {
          fail('minimal-std-abi-operation-digest-mismatch')
        }
      }
      for (const typeEntry of module.types) {
        exactFields(typeEntry, REPORT_TYPE_FIELDS, 'report-type')
        if (!DIGEST.test(typeEntry.declaration_digest)
          || typeEntry.declaration_digest !==
            typeDeclarationDigest(typeEntry.declaration)) {
          fail('minimal-std-abi-type-digest-mismatch')
        }
      }
    }
    return { ok: true }
  } catch (error) {
    return rejected(error)
  }
}

function normalizeCorpus(corpus) {
  return {
    modules: [...corpus.modules]
      .map((module) => ({
        module: module.module,
        operations: [...module.operations]
          .map((entry) => {
            const expected = MINIMAL_STD_ABI_MODULES
              .find(({ module: name }) => name === module.module)
            const declarations = new Map((expected?.types ?? []).map((declaration) => [
              typeDeclarationDigest(declaration),
              declaration,
            ]))
            return normalizeOperation(entry, declarations)
          })
          .sort((left, right) => compareText(left.name, right.name)),
        types: [...module.types]
          .sort((left, right) => compareText(left.name, right.name)),
      }))
      .sort((left, right) => compareText(left.module, right.module)),
    package: corpus.package,
    schema: corpus.schema,
  }
}

function exactFields(value, fields, label) {
  if (!plainObject(value)) {
    fail(`minimal-std-abi-${label}-invalid`)
  }
  if (!canonicalEqual(Object.keys(value).sort(), [...fields].sort())) {
    fail(`minimal-std-abi-${label}-fields-mismatch`)
  }
}

function indexBy(values, field, label) {
  if (!Array.isArray(values)) fail(`minimal-std-abi-${label}-mismatch`)
  const result = new Map()
  for (const value of values) {
    if (!plainObject(value)
      || typeof value[field] !== 'string'
      || result.has(value[field])) {
      fail(`minimal-std-abi-${label}-mismatch`)
    }
    result.set(value[field], value)
  }
  return result
}

function sameSet(actual, expected) {
  return canonicalEqual([...actual].sort(compareText), [...expected].sort(compareText))
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`
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

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(code) {
  throw new TypeError(code)
}

function rejected(error) {
  const code = typeof error === 'string'
    ? error
    : error?.message ?? 'minimal-std-abi-invalid'
  return { diagnostics: [{ code }], ok: false }
}
