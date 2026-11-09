import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

test('native project-init output is documented and checkable by native check', () => {
  // `projects/README.md` promises a deterministic starter and names the command
  // that checks it. Re-run the measured boundary: the starter seals a
  // `re 0.1 compact` module, which the source CLI cannot check.
  const readme = readFileSync(new URL('../projects/README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes('native/target/release/revia project-init <directory>'))
  assert.ok(readme.includes('`re.native-project-init@0.1.0`'))
  assert.ok(readme.includes('`unsupported-module-surface-header`'))
  assert.ok(readme.includes('`native-project-module-surface-header-unsupported`'))
  assert.ok(readme.includes('`re.native-project-graph@0.1.0`'))
  assert.ok(readme.includes('cargo build --workspace --release'))
  const template = readFileSync(
    new URL('../projects/_template/README.md', import.meta.url),
    'utf8'
  )
  assert.ok(template.includes('native/target/release/revia project-surface-check'))

  const root = new URL('../', import.meta.url).pathname
  const binary = resolve(root, 'native/target/release/revia')
  if (!existsSync(binary)) return

  const target = join(mkdtempSync(join(tmpdir(), 'revia-project-init-')), 'starter')
  const init = spawnSync(binary, ['project-init', target], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const initBody = JSON.parse(init.stdout)
  assert.equal(initBody.schema, 're.native-project-init@0.1.0')
  assert.equal(initBody.ok, true)
  assert.ok(readFileSync(join(target, 'modules/main.re'), 'utf8').startsWith('re 0.1 compact\n'))

  const nodeCheck = spawnSync(
    process.execPath,
    ['src/cli/re.js', 'project-check', '--format', 'json', target],
    { cwd: root, encoding: 'utf8' }
  )
  assert.equal(nodeCheck.status, 65, nodeCheck.stderr)
  const nodeBody = JSON.parse(nodeCheck.stdout)
  assert.equal(nodeBody.ok, false)
  assert.ok(nodeBody.diagnostics.some((entry) => entry.code === 'unsupported-module-surface-header'))

  const surface = spawnSync(binary, ['project-surface-check', target], { encoding: 'utf8' })
  assert.equal(surface.status, 65)
  assert.equal(
    JSON.parse(surface.stdout).diagnostics[0].code,
    'native-project-module-surface-header-unsupported'
  )

  const nativeCheck = spawnSync(binary, ['project-check', target], { encoding: 'utf8' })
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr)
  assert.equal(JSON.parse(nativeCheck.stdout).schema, 're.native-project-graph@0.1.0')

  const sourcePath = join(target, 'modules/main.re')
  writeFileSync(
    sourcePath,
    readFileSync(sourcePath, 'utf8').replace(
      're 0.1 compact\n',
      're 1.0 compact\nmodule revia.app.main\n'
    )
  )
  const tampered = spawnSync(
    process.execPath,
    ['src/cli/re.js', 'project-check', '--format', 'json', target],
    { cwd: root, encoding: 'utf8' }
  )
  assert.equal(tampered.status, 65)
  assert.ok(
    JSON.parse(tampered.stdout).diagnostics.some(
      (entry) => entry.code === 'project-module-source-digest-mismatch'
    )
  )

  const templateCheck = spawnSync(binary, ['project-surface-check', 'projects/_template'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(templateCheck.status, 0, templateCheck.stderr)
  assert.equal(
    JSON.parse(templateCheck.stdout).schema,
    're.native-project-surface-result@0.1.0'
  )
})
