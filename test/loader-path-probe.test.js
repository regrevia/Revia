import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { classifyLoaderPathProbe } from '../src/toolchain/loader-path-probe.js'

const repository = new URL('../', import.meta.url)
const RECORD = 'runtime/rc2.2.1/loader-path-probe.json'

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, repository), 'utf8'))
}

const record = await readJson(RECORD)

function measured(probes) {
  return { schema: 'revia.loader-path-probe@1.0.0', status: 'measured', probes }
}

test('the shipped probe record is pending, so the path claim is not a measurement', () => {
  assert.equal(record.status, 'pending')
  assert.match(record.unrecorded_reason, /no host below glibc 2\.39/u)
  assert.deepEqual(classifyLoaderPathProbe(record), { measured: false, observedPaths: 0, pathIndependent: false })
})

test('the page states the probe is unrecorded and names the record that says so', async () => {
  const page = await readFile(new URL('docs/compatibility.md', repository), 'utf8')
  const state = classifyLoaderPathProbe(record)
  if (state.measured) {
    // Flipping the record to a measurement moves the obligation to the page: it
    // must then cite the observation instead of saying it was never made.
    assert.equal(state.pathIndependent, true, 'a measured probe must be path-independent to be citable')
    assert.match(page, /The loader failure was re-run from two `libc\.so\.6` paths/u)
  } else {
    assert.match(page, /the example was not re-run from a second path/u)
    assert.match(page, /上面的例子没有从第二条路径重跑过/u)
  }
  assert.ok(page.includes(RECORD), 'the page must name the record that carries the probe state')
})

test('two paths whose loader messages agree once the path is masked are path-independent', () => {
  const shared = 'revia: <libc>: version `GLIBC_2.39\' not found (required by ./revia)'
  const state = classifyLoaderPathProbe(measured([
    { libc_path: '/lib/x86_64-linux-gnu/libc.so.6', diagnostic: shared.replace('<libc>', '/lib/x86_64-linux-gnu/libc.so.6') },
    { libc_path: '/lib64/libc.so.6', diagnostic: shared.replace('<libc>', '/lib64/libc.so.6') },
  ]))
  assert.deepEqual(state, { measured: true, observedPaths: 2, pathIndependent: true })
})

test('a second path that changes the message is reported as dependent', () => {
  const state = classifyLoaderPathProbe(measured([
    { libc_path: '/lib/x86_64-linux-gnu/libc.so.6', diagnostic: "revia: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found" },
    { libc_path: '/lib64/libc.so.6', diagnostic: 'revia: cannot execute: required file not found' },
  ]))
  assert.equal(state.measured, true)
  assert.equal(state.pathIndependent, false)
})

test('one path, or a malformed probe, leaves the claim unmeasured', () => {
  const one = classifyLoaderPathProbe(measured([
    { libc_path: '/lib64/libc.so.6', diagnostic: "revia: /lib64/libc.so.6: version `GLIBC_2.39' not found" },
  ]))
  assert.deepEqual(one, { measured: false, observedPaths: 1, pathIndependent: false })
  assert.equal(classifyLoaderPathProbe(measured([{ libc_path: 'libc.so.6', diagnostic: 'x' }])).measured, false)
  assert.equal(classifyLoaderPathProbe(measured([{ libc_path: '/lib64/libc.so.6' }])).measured, false)
  assert.equal(classifyLoaderPathProbe({ ...measured([]), schema: 'other' }).measured, false)
})
