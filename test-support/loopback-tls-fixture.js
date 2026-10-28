import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OPENSSL_CANDIDATES = [
  '/usr/bin/openssl',
  '/opt/homebrew/bin/openssl',
]

export async function createLoopbackTlsCredentials() {
  const openssl = await findOpenSsl()
  if (openssl === null) return null
  const root = await mkdtemp(join(tmpdir(), 're-loopback-tls-'))
  try {
    const paths = {
      caCert: join(root, 'ca-cert.pem'),
      caKey: join(root, 'ca-key.pem'),
      extension: join(root, 'server.ext'),
      serverCert: join(root, 'server-cert.pem'),
      serverCsr: join(root, 'server.csr'),
      serverKey: join(root, 'server-key.pem'),
    }
    run(openssl, [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', paths.caKey,
      '-out', paths.caCert,
      '-subj', '/CN=RE Loopback Test CA',
      '-days', '1',
    ])
    run(openssl, [
      'req', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', paths.serverKey,
      '-out', paths.serverCsr,
      '-subj', '/CN=localhost',
    ])
    await writeFile(
      paths.extension,
      'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
      'utf8',
    )
    run(openssl, [
      'x509', '-req',
      '-in', paths.serverCsr,
      '-CA', paths.caCert,
      '-CAkey', paths.caKey,
      '-CAcreateserial',
      '-out', paths.serverCert,
      '-days', '1',
      '-extfile', paths.extension,
    ])
    return {
      ca: await readFile(paths.caCert),
      cert: await readFile(paths.serverCert),
      close: () => rm(root, { force: true, recursive: true }),
      key: await readFile(paths.serverKey),
    }
  } catch (error) {
    await rm(root, { force: true, recursive: true })
    throw error
  }
}

async function findOpenSsl() {
  for (const path of OPENSSL_CANDIDATES) {
    try {
      await access(path, constants.X_OK)
      return path
    } catch {
      // Try the next fixed absolute path.
    }
  }
  return null
}

function run(openssl, arguments_) {
  const result = spawnSync(openssl, arguments_, {
    encoding: 'utf8',
    shell: false,
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new TypeError('loopback TLS fixture unavailable')
  }
}
