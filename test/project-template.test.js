import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const projectRoot = new URL('../projects/_template/', import.meta.url)

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const fields = Object.keys(value).sort()
    return `{${fields.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

test('public project template manifest is canonical and bound to its source', () => {
  const manifestBytes = readFileSync(new URL('project.json', projectRoot))
  const sourceBytes = readFileSync(new URL('modules/main.re', projectRoot))
  const manifest = JSON.parse(manifestBytes)

  assert.equal(manifest.schema, 're.project-manifest@0.1.0')
  assert.equal(manifest.modules.length, 1)
  assert.equal(manifest.modules[0].name, 'revia.app.main')
  assert.equal(manifest.modules[0].path, 'modules/main.re')
  assert.equal(manifest.modules[0].source_sha256, sha256(sourceBytes))

  const [packageModule] = manifest.package_manifest.modules
  assert.equal(packageModule.implementation_digest, sha256(sourceBytes))
  assert.equal(packageModule.interface_digest, sha256(Buffer.from(canonical(packageModule.interface))))
  assert.equal(manifestBytes.toString('utf8'), `${canonical(manifest)}\n`)
})

test('public project template passes the source CLI project workflow', () => {
  const root = new URL('../', import.meta.url).pathname
  for (const args of [
    ['project-check', '--format', 'json', 'projects/_template'],
  ]) {
    const result = spawnSync(process.execPath, ['src/cli/re.js', ...args], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    assert.match(result.stdout, /"ok":true/u)
  }
})
