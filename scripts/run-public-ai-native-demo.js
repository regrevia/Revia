#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

import { runPublicAiNativeDemo } from '../src/toolchain/public-ai-native-demo.js'

const root = new URL('../', import.meta.url)
const readJson = async (path) => JSON.parse(await readFile(
  new URL(path, root),
  'utf8',
))

const report = await runPublicAiNativeDemo({
  corpus: await readJson('test/fixtures/agent-writing-evaluation-corpus.json'),
  project: await readJson('test/fixtures/agent-writing-evaluation-project.json'),
  expense_project_path: 'examples/agent-expense-review',
  expense_run_fixture_path: 'examples/agent-expense-review-run.json',
  root,
})

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
