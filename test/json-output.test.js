import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  serializeAuditResult,
  serializeBuildResult,
  serializeProfileResult,
  serializeReviewIndexResult,
  serializeRunResult,
  serializeTranslationResult,
} from '../src/host/json-output.js'

const readGolden = async (name) =>
  readFile(new URL(`golden/${name}`, import.meta.url), 'utf8')

test('run process-status output matches the byte-exact golden envelope', async () => {
  const actual = serializeRunResult({
    outcome: { kind: 'process-status', status: { code: 1 } },
    programStdout: 'ready\n',
  })

  assert.equal(actual, await readGolden('run-process-status.json'))
})

test('run host-fault output matches the byte-exact golden envelope', async () => {
  const actual = serializeRunResult({
    outcome: {
      fault: {
        reason: 'return-type-mismatch',
        phase: 'invoke',
        node_uid: '3kf2a2bc4de6fg7h2j4km6np7q',
        member: 'read_file',
        code: 'host-contract-violation',
        capability_reference: 'fs.read@0.1.0',
        capability_instance: '@input',
      },
      kind: 'host-fault',
    },
  })

  assert.equal(actual, await readGolden('run-host-fault.json'))
})

test('run check-failure sorts diagnostics before serialization', async () => {
  const actual = serializeRunResult({
    outcome: {
      diagnostics: [
        {
          code: 'unknown-capability-member',
          column: 2,
          file: 'z.re',
          line: 1,
          reference: '@input.delete_file',
        },
        {
          code: 'missing-schema-revision',
          column: 13,
          file: 'a.re',
          line: 4,
          reference: 'fs.read@0.2.0',
        },
      ],
      kind: 'check-failure',
    },
  })

  assert.equal(actual, await readGolden('run-check-failure.json'))
})

test('audit output sorts semantic collections and matches its golden', async () => {
  const actual = serializeAuditResult({
    capabilities: [
      {
        binding_kind: 'memory',
        instance: '@stdout',
        reference: 'process.stdout@0.1.0',
      },
      {
        binding_kind: 'memory',
        instance: '@args',
        reference: 'process.args@0.1.0',
      },
    ],
    effects: [
      {
        access: ['read process.argv'],
        capability_instance: '@args',
        member: 'read',
        node_uid: '7q2mxc2de4fg6h2j4km6np7r5q',
        result_consumers: ['bq2mxc2de4fg6h2j4km6np7r5q'],
        returns: 'result<list<text.utf8>, process.args_error>',
      },
      {
        access: ['write process.stdout'],
        capability_instance: '@stdout',
        member: 'write',
        node_uid: '3kf2a2bc4de6fg7h2j4km6np7q',
        result_consumers: ['aq2mxc2de4fg6h2j4km6np7r5q'],
        returns: 'result<unit, io.write_error>',
      },
    ],
    errorPaths: [
      {
        consumer_uid: 'bq2mxc2de4fg6h2j4km6np7r5q',
        error_type: 'process.args_error',
        producer_uid: '7q2mxc2de4fg6h2j4km6np7r5q',
        status_codes: [2],
      },
      {
        consumer_uid: 'aq2mxc2de4fg6h2j4km6np7r5q',
        error_type: 'io.write_error',
        producer_uid: '3kf2a2bc4de6fg7h2j4km6np7q',
        status_codes: [1, 0, 1],
      },
    ],
    statusCodes: [2, 1, 0, 1],
  })

  assert.equal(actual, await readGolden('audit-result.json'))
})

test('build result output uses a stable envelope', () => {
  const actual = serializeBuildResult({
    outDir: '/tmp/re-artifact',
    result: {
      ok: true,
      value: {
        manifest: {
          build_key: `sha256:${'e'.repeat(64)}`,
          files: [
            {
              bytes: 10,
              executable: false,
              path: 'program.re',
              sha256: 'a'.repeat(64),
            },
          ],
          graph_revision: `sha256:${'b'.repeat(64)}`,
          manifest_sha256: 'c'.repeat(64),
          required_capabilities: [],
          runtime: {
            entrypoint: 'run.mjs',
            kind: 'external-re-cli-stub',
          },
          schema: 're.build-artifact@0.1.0',
          source_sha256: 'd'.repeat(64),
          target_profile: 'node-demo-cli-stub@0.1.0',
          unit: '@hello',
        },
      },
    },
  })

  assert.equal(
    actual,
    `{"artifact":{"build_key":"sha256:${'e'.repeat(64)}","files":[{"bytes":10,"executable":false,"path":"program.re","sha256":"${'a'.repeat(64)}"}],"graph_revision":"sha256:${'b'.repeat(64)}","manifest_sha256":"${'c'.repeat(64)}","required_capabilities":[],"runtime":{"entrypoint":"run.mjs","kind":"external-re-cli-stub"},"schema":"re.build-artifact@0.1.0","source_sha256":"${'d'.repeat(64)}","target_profile":"node-demo-cli-stub@0.1.0","unit":"@hello"},"ok":true,"out_dir":"/tmp/re-artifact","schema":"re.build-result@0.1.0"}\n`,
  )
})

test('project review index result uses a stable envelope', () => {
  const actual = serializeReviewIndexResult({
    file: 'hello.re',
    result: {
      ok: true,
      value: {
        entries: [{
          fact_id: 'fact:project/@hello',
          graph_revision: `sha256:${'a'.repeat(64)}`,
          index_revision: `sha256:${'b'.repeat(64)}`,
          kind: 'module',
          module: '@hello',
          module_interface_digest: `sha256:${'c'.repeat(64)}`,
          path: ['project', '@hello'],
          summary: '@hello',
          uid_anchor: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
        }],
        graph_revision: `sha256:${'a'.repeat(64)}`,
        index_revision: `sha256:${'b'.repeat(64)}`,
        module_interface_digest: `sha256:${'c'.repeat(64)}`,
        next_cursor: null,
        schema: 're.project-review-index@0.1.0',
      },
    },
  })

  assert.equal(
    actual,
    `{"file":"hello.re","index":{"entries":[{"fact_id":"fact:project/@hello","graph_revision":"sha256:${'a'.repeat(64)}","index_revision":"sha256:${'b'.repeat(64)}","kind":"module","module":"@hello","module_interface_digest":"sha256:${'c'.repeat(64)}","path":["project","@hello"],"summary":"@hello","uid_anchor":"aaaaaaaaaaaaaaaaaaaaaaaaaa"}],"graph_revision":"sha256:${'a'.repeat(64)}","index_revision":"sha256:${'b'.repeat(64)}","module_interface_digest":"sha256:${'c'.repeat(64)}","next_cursor":null,"schema":"re.project-review-index@0.1.0"},"ok":true,"schema":"re.project-review-index-result@0.1.0"}\n`,
  )
})

test('profile result output uses a stable envelope', () => {
  const actual = serializeProfileResult({
    file: 'hello.re',
    result: {
      ok: true,
      value: {
        benchmark_profile_digest: `sha256:${'c'.repeat(64)}`,
        graph_revision: `sha256:${'a'.repeat(64)}`,
        measurement_status: 'not-run',
        module_interface_digest: `sha256:${'b'.repeat(64)}`,
        runtime: { kind: 'self-contained-node-demo-runtime' },
        schema: 're.profile-descriptor@0.1.0',
        target_profile: 'node-demo-self-contained-preview@0.1.0',
        workloads: [{
          id: 'cold-start',
          required_axes: ['cold_start_ms', 'artifact_bytes'],
        }],
      },
    },
  })

  assert.equal(
    actual,
    `{"file":"hello.re","ok":true,"profile":{"benchmark_profile_digest":"sha256:${'c'.repeat(64)}","graph_revision":"sha256:${'a'.repeat(64)}","measurement_status":"not-run","module_interface_digest":"sha256:${'b'.repeat(64)}","runtime":{"kind":"self-contained-node-demo-runtime"},"schema":"re.profile-descriptor@0.1.0","target_profile":"node-demo-self-contained-preview@0.1.0","workloads":[{"id":"cold-start","required_axes":["cold_start_ms","artifact_bytes"]}]},"schema":"re.profile-result@0.1.0"}\n`,
  )
})

test('translation result output uses a stable envelope', () => {
  const actual = serializeTranslationResult({
    file: 'hello.re',
    result: {
      ok: true,
      value: {
        artifact_sha256: `sha256:${'a'.repeat(64)}`,
        canonical: {
          bytes: 're 0.1 canonical\nunit @hello\n',
          schema: 're.canonical-graph@0.1.0',
          sha256: `sha256:${'c'.repeat(64)}`,
        },
        graph_revision: `sha256:${'b'.repeat(64)}`,
        runtime: { kind: 'node-demo-reference' },
        schema: 're.execution-artifact@0.1.0',
        target_profile: 'node-demo-translator@0.1.0',
        unit: '@hello',
      },
    },
  })

  assert.equal(
    actual,
    `{"artifact":{"artifact_sha256":"sha256:${'a'.repeat(64)}","canonical":{"bytes":"re 0.1 canonical\\nunit @hello\\n","schema":"re.canonical-graph@0.1.0","sha256":"sha256:${'c'.repeat(64)}"},"graph_revision":"sha256:${'b'.repeat(64)}","runtime":{"kind":"node-demo-reference"},"schema":"re.execution-artifact@0.1.0","target_profile":"node-demo-translator@0.1.0","unit":"@hello"},"file":"hello.re","ok":true,"schema":"re.translation-result@0.1.0"}\n`,
  )
})
