import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repository = new URL('../', import.meta.url)

async function read(relativePath) {
  return readFile(new URL(relativePath, repository), 'utf8')
}

// The published linux-x64 binary reports GLIBC_2.39 as its highest required
// symbol version (`strings -a revia | grep -o 'GLIBC_2\.[0-9]*' | sort -uV`
// on the executable named by `binary_sha256` below). These docs state that
// floor for readers; this test keeps the statements and the cited evidence
// aligned. This test does not read the symbol table: the constant is a recorded
// measurement and the digests pin the artifacts it came from, so a silent doc
// edit alone cannot pass — the floor must move in the docs and here together.
const REQUIRED_GLIBC_MINOR = '39'
// English heading and ASCII anchor on purpose: both README files link to
// `docs/compatibility.md#<anchor>`, and a bilingual heading would change the
// anchor GitHub generates.
const HEADING = 'Linux x64 Runtime Baseline'
const compatibility = await read('docs/compatibility.md')
const readme = await read('README.md')
const readmeChinese = await read('README.zh-CN.md')
const quickstart = await read('QUICKSTART.md')

function sectionOf(text) {
  const start = text.indexOf(`## ${HEADING}`)
  assert.ok(start > 0, `docs/compatibility.md must carry the ## ${HEADING} heading`)
  const end = text.indexOf('\n## ', start + 1)
  return text.slice(start, end === -1 ? undefined : end)
}

// Line wrapping must not decide whether a fact is covered: compare on a single
// whitespace-normalised line.
function flatten(text) {
  return text.replace(/\s+/gu, ' ')
}

test('linux-x64 runtime baseline matches the published binary', async () => {
  const section = sectionOf(compatibility)
  const flatSection = flatten(section)
  // The English half ends where the Chinese half starts, so a statement present
  // only in one language cannot satisfy the other half's assertion.
  const chineseStart = section.indexOf('`v1.0.0-rc.2.2.1` 的 Linux x64')
  assert.ok(chineseStart > 0, 'the baseline section must carry a Chinese half')
  const english = flatten(section.slice(0, chineseStart))
  const chinese = flatten(section.slice(chineseStart))

  const linuxEvidence = JSON.parse(await read('runtime/rc2.2.1/linux-native-evidence.json'))
  assert.equal(linuxEvidence.status, 'measured-native')
  assert.equal(linuxEvidence.target, 'linux-x64')
  // Bind each digest to the artifact it names: swapping them, or attaching one
  // to the wrong file, would leave the section misleading while still
  // containing both strings.
  const archiveName = '`revia-1\\.0\\.0-rc\\.2\\.2\\.1-linux-x64\\.tar\\.gz`'
  for (const [name, text, binaryLabel] of [
    ['English', english, 'executable `revia`'],
    ['Chinese', chinese, '可执行文件 `revia`'],
  ]) {
    // Loose between the two so a different connector word still counts.
    assert.match(
      text,
      new RegExp(archiveName + '[^)]{0,40}' + linuxEvidence.archive_sha256, 'u'),
      `${name} half must give the archive digest next to the archive name`,
    )
    assert.match(
      text,
      new RegExp(binaryLabel + '[^)]{0,40}' + linuxEvidence.binary_sha256, 'u'),
      `${name} half must give the binary digest next to the executable name`,
    )
  }

  // Both language halves must state a requirement, not merely mention 2.39.
  const glibcVersion = '2\\.' + REQUIRED_GLIBC_MINOR
  const symbolVersion = '`GLIBC_2\\.' + REQUIRED_GLIBC_MINOR + '`'
  assert.match(english, new RegExp('requires glibc \\*\\*' + glibcVersion + '\\*\\*', 'u'))
  assert.match(english, new RegExp('requires the symbol version ' + symbolVersion, 'u'))
  assert.match(english, new RegExp(glibcVersion + ' is the lowest\\s+libc that provides it', 'u'))
  assert.match(chinese, new RegExp('要求 glibc \\*\\*' + glibcVersion + '\\*\\*', 'u'))
  assert.match(chinese, new RegExp(symbolVersion, 'u'))
  assert.match(chinese, new RegExp(glibcVersion + ' 是提供该符号版本的\\s*最低\\s*libc', 'u'))

  // Each entry document must state the requirement in its own language.
  assert.match(readme, /requires \*\*glibc 2\.39\*\*/u)
  assert.match(readmeChinese, /要求 \*\*glibc 2\.39\*\*/u)
  assert.match(quickstart, /requires \*\*glibc 2\.39\*\*/u)
  assert.match(quickstart, /要求 \*\*glibc 2\.39\*\*/u)

  const anchor = `docs/compatibility.md#${HEADING.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`
  for (const [name, text] of [
    ['README.md', readme],
    ['README.zh-CN.md', readmeChinese],
  ]) {
    assert.ok(text.includes(anchor), `${name} must link to ${anchor}`)
  }

  // The floor is a libc version, not an Ubuntu-only property: name hosts on
  // both sides of 2.39 so the statement stays falsifiable, and say how a reader
  // checks their own host.
  for (const host of [
    /Ubuntu 20\.04 \(2\.31\)/u,
    /22\.04 \(2\.35\)/u,
    /Debian 12 \(2\.36\)/u,
    /RHEL 9 and Amazon Linux 2023 \(2\.34\)/u,
    /Fedora 39 \(2\.38\) and earlier/u,
  ]) {
    assert.match(flatSection, host, `the baseline section must name hosts matching ${host}`)
  }
  // Every parenthesised glibc number in the section, not only the five hosts
  // the statements above name: a silent edit to an unlisted pair (Ubuntu 23.10
  // is one) must fail here rather than stay green.
  const expectedPairs = ['2.31', '2.34', '2.35', '2.36', '2.38', '2.38']
  for (const [name, half] of [['English', english], ['Chinese', chinese]]) {
    const pairs = [...half.matchAll(/[\(（](2\.\d+)[\)）]/gu)].map((match) => match[1])
    assert.deepEqual(
      [...pairs].sort(),
      expectedPairs,
      `${name} half must carry exactly the baseline section's host glibc pairs`,
    )
    for (const pair of pairs) {
      assert.ok(
        Number(pair.slice(2)) < Number(REQUIRED_GLIBC_MINOR),
        `${name} half must not place ${pair} at or above the stated floor`,
      )
    }
    assert.match(half, /Ubuntu 23\.10\s*[\(（]2\.38[\)）]/u)
    assert.match(half, /openSUSE Leap 15\.x/u)
  }
  assert.match(flatSection, /getconf GNU_LIBC_VERSION/u)
  assert.match(flatSection, /No `-musl` or static variant is published/u)
  // Only the glibc 2.31 host was externally reported; do not pin the report to
  // another version, and do not present loading as support.
  assert.match(flatSection, /glibc 2\.31 host has been reported externally/u)
  assert.match(flatSection, /only `ubuntu-24\.04` has actually been exercised/u)
  assert.match(flatSection, /Building from source on a host below glibc 2\.39 has not been verified/u)
})
