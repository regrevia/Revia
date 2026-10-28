import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadProjectDirectory } from '../src/toolchain/project-loader.js'

const fixture = new URL('./fixtures/agent-expense-review/', import.meta.url)

test('agent expense review fixture has a stable six-module project graph', async () => {
  const first = await loadProjectDirectory(fixture.pathname)
  assert.equal(first.ok, true)
  assert.equal(first.value.agents.length, 1)
  assert.equal(first.value.agents[0].agent, 'agent.expense.intake')
  assert.equal(first.value.agents[0].schema, 're.agent-lifecycle@0.1.0')
  assert.equal(first.value.package_digest, 'sha256:6a1e2a0a4563a5ef79a0b58433a31088f52e121cb6405cb91e1c37c489d5f7bb')
  assert.deepEqual(
    first.value.modules.map(({ name }) => name),
    [
      'agent.expense.domain',
      'agent.expense.policy',
      'agent.expense.persistence',
      'agent.expense.intake',
      'agent.expense.approval',
      'agent.expense.api',
    ],
  )

  const root = await mkdtemp(join(tmpdir(), 're-agent-project-'))
  await mkdir(join(root, 'modules'))
  const manifest = JSON.parse(await readFile(join(fixture.pathname, 'project.json'), 'utf8'))
  manifest.modules.reverse()
  for (const entry of manifest.modules) {
    await writeFile(
      join(root, entry.path),
      await readFile(join(fixture.pathname, entry.path), 'utf8'),
    )
  }
  await writeFile(join(root, 'project.json'), `${JSON.stringify(manifest)}\n`)
  const second = await loadProjectDirectory(root)
  assert.equal(second.ok, true)
  assert.equal(second.value.graph_revision, first.value.graph_revision)
  assert.equal(second.value.project_digest, first.value.project_digest)
})

test('agent project loader rejects duplicate Agent identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 're-agent-project-identity-'))
  await mkdir(join(root, 'modules'))
  const manifest = JSON.parse(await readFile(join(fixture.pathname, 'project.json'), 'utf8'))
  for (const entry of manifest.modules) {
    await writeFile(
      join(root, entry.path),
      await readFile(join(fixture.pathname, entry.path), 'utf8'),
    )
  }
  manifest.agents.push(structuredClone(manifest.agents[0]))
  await writeFile(join(root, 'project.json'), `${JSON.stringify(manifest)}\n`)

  const result = await loadProjectDirectory(root)
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'duplicate-project-agent')
})

test('agent project loader rejects an Agent contract for an unlisted module', async () => {
  const root = await mkdtemp(join(tmpdir(), 're-agent-project-module-'))
  await mkdir(join(root, 'modules'))
  const manifest = JSON.parse(await readFile(join(fixture.pathname, 'project.json'), 'utf8'))
  for (const entry of manifest.modules) {
    await writeFile(
      join(root, entry.path),
      await readFile(join(fixture.pathname, entry.path), 'utf8'),
    )
  }
  manifest.agents[0].module = 'agent.expense.missing'
  await writeFile(join(root, 'project.json'), `${JSON.stringify(manifest)}\n`)

  const result = await loadProjectDirectory(root)
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'agent-module-not-in-project')
})

test('agent project loader rejects a symlinked module outside the project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 're-agent-project-link-'))
  const outside = await mkdtemp(join(tmpdir(), 're-agent-project-outside-'))
  await mkdir(join(root, 'modules'))
  const source = await readFile(join(fixture.pathname, 'modules/domain.re'), 'utf8')
  const sourcePath = join(outside, 'domain.re')
  await writeFile(sourcePath, source)
  await symlink(sourcePath, join(root, 'modules/domain.re'))
  const manifest = JSON.parse(await readFile(join(fixture.pathname, 'project.json'), 'utf8'))
  manifest.modules = [manifest.modules[0]]
  manifest.package_manifest.modules = [manifest.package_manifest.modules[0]]
  await writeFile(join(root, 'project.json'), `${JSON.stringify(manifest)}\n`)

  const result = await loadProjectDirectory(root)
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'project-module-path-escapes-root')
})
