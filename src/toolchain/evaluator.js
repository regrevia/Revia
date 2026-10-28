import { demoSchemaDefinitions } from '../host/demo-schema.js'
import { FileSandboxAdapter } from '../host/file-sandbox-adapter.js'
import { HostEnvironment } from '../host/host-environment.js'
import { MemoryAdapter } from '../host/memory-adapter.js'
import { SchemaRegistry } from '../host/schema-registry.js'
import { executePortableProgram } from './portable-executor.js'
import {
  executeMinimalStdOperation,
  MINIMAL_STD_INVOCATION_SCHEMA,
  minimalStdPackageIdentityForGraph,
} from './minimal-std-subset.js'
import { graphRevision } from './structured-patch.js'

export function evaluateProgram(
  program,
  { argv = [], fileSandboxRoot, host = {}, stdout = [] } = {},
) {
  const memoryAdapter = new MemoryAdapter({ argv, stdout, ...host })
  const fileAdapter = fileSandboxRoot === undefined
    ? null
    : new FileSandboxAdapter({ root: fileSandboxRoot })
  const registry = SchemaRegistry.load(demoSchemaDefinitions()).value
  const bound = HostEnvironment.bind({
    bindings: program.capabilities.map(({ instance, reference }) => ({
      adapter:
        fileAdapter !== null && isFileCapability(reference)
          ? fileAdapter
          : memoryAdapter,
      instance,
    })),
    capabilities: program.capabilities,
    registry,
  })
  if (!bound.ok) {
    return {
      diagnostics: bound.diagnostics,
      kind: 'check-failure',
    }
  }
  const std = minimalStdPackageIdentityForGraph(program)
  if (!std.ok) {
    return { diagnostics: std.diagnostics, kind: 'check-failure' }
  }

  return executePortableProgram(program, {
    invokeCapability(instance, member, arguments_, invocationId) {
      return bound.value.invoke(instance, member, arguments_, invocationId)
    },
    invokePureOperation(operation, parameters) {
      const executed = executeMinimalStdOperation({
        graph_revision: graphRevision(program),
        operation,
        package_manifest: std.value.package_manifest,
        parameters,
        schema: MINIMAL_STD_INVOCATION_SCHEMA,
        type_arguments: [],
      })
      return executed.ok
        ? { ok: true, value: executed.value.outcome }
        : executed
    },
  })
}

function isFileCapability(reference) {
  return reference === 'fs.read@0.1.0' || reference === 'fs.write@0.1.0'
}
