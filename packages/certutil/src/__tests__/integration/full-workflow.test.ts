import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import forge from 'node-forge'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import { createAuthority, createWorkspace, loadIdentity, removeWorkspace, runCli } from '../support/cli'
import { performMutualTlsHandshake } from '../support/tls'

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const VALIDITY_DAYS = 30

function signRequestAsExternalAuthority(csrPem: string, authorityCertPem: string, authorityKeyPem: string): string {
  const request = forge.pki.certificationRequestFromPem(csrPem)
  const requestedPublicKey = request.publicKey
  if (requestedPublicKey === null) {
    throw new Error('The CSR holds no public key')
  }
  const requestedExtensions = request.getAttribute({ name: 'extensionRequest' })?.extensions ?? []
  const certificate = forge.pki.createCertificate()
  certificate.publicKey = requestedPublicKey
  certificate.serialNumber = '01'
  certificate.validity.notBefore = new Date()
  certificate.validity.notAfter = new Date(Date.now() + VALIDITY_DAYS * MILLISECONDS_PER_DAY)
  certificate.setSubject(request.subject.attributes)
  certificate.setIssuer(forge.pki.certificateFromPem(authorityCertPem).subject.attributes)
  certificate.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    ...requestedExtensions,
  ])
  certificate.sign(forge.pki.privateKeyFromPem(authorityKeyPem), forge.md.sha256.create())
  return forge.pki.certificateToPem(certificate)
}

describe('documented certificate workflows', () => {
  let root: string

  beforeAll(async () => {
    root = await createWorkspace()
  })

  afterAll(async () => {
    await removeWorkspace(root)
  })

  it('takes a cluster from a new CA through batch issue, verification, PKCS#12, and live mTLS', async () => {
    const certsDir = join(root, 'cluster')
    const authority = await createAuthority(certsDir, 'Cluster CA')
    const configPath = join(certsDir, 'cluster.yaml')
    await writeFile(
      configPath,
      stringifyYaml({
        nodes: [
          { cn: 'node1', ip: ['127.0.0.1'], dns: ['node1.cluster.local'] },
          { cn: 'node2', ip: ['127.0.0.1'], dns: ['node2.cluster.local'] },
        ],
      }),
    )

    const issued = await runCli([
      'cert',
      '--ca-cert',
      authority.certPath,
      '--ca-key',
      authority.keyPath,
      '--nodes',
      configPath,
      '--out-dir',
      certsDir,
    ])
    expect(issued.code).toBe(0)

    for (const cn of ['node1', 'node2']) {
      const verified = await runCli([
        'verify',
        '--cert',
        join(certsDir, cn, `${cn}.crt`),
        '--key',
        join(certsDir, cn, `${cn}.key`),
        '--ca-cert',
        authority.certPath,
      ])
      expect(verified.code).toBe(0)
      expect(verified.stdout).not.toContain('FAIL')
    }

    const password = 'cluster-keystore-password'
    const p12Dir = join(certsDir, 'node1', 'p12')
    const converted = await runCli([
      'convert',
      '--cert',
      join(certsDir, 'node1', 'node1.crt'),
      '--key',
      join(certsDir, 'node1', 'node1.key'),
      '--ca-cert',
      authority.certPath,
      '--to',
      'p12',
      '--p12-password',
      password,
      '--out-dir',
      p12Dir,
    ])
    expect(converted.code).toBe(0)

    const node2 = await loadIdentity(join(certsDir, 'node2', 'node2.crt'), join(certsDir, 'node2', 'node2.key'))
    const exchange = await performMutualTlsHandshake({
      server: {
        ca: authority.certPem,
        pfx: await readFile(join(p12Dir, 'certificate.p12')),
        passphrase: password,
      },
      client: { ca: authority.certPem, cert: node2.certPem, key: node2.keyPem },
      servername: 'node1.cluster.local',
    })
    expect(exchange.clientPeerCn).toBe('node1')
    expect(exchange.serverPeerCn).toBe('node2')
  })

  it('accepts certificates that an external CA signed from CSRs made by the CLI', async () => {
    const workDir = join(root, 'external')
    const companyCa = await createAuthority(join(workDir, 'company-ca'), 'Company CA')
    const csrDir = join(workDir, 'csrs')
    const configPath = join(root, 'external-cluster.yaml')
    await writeFile(
      configPath,
      stringifyYaml({
        nodes: [
          { cn: 'node1', ip: ['127.0.0.1'] },
          { cn: 'node2', dns: ['node2.cluster.local'] },
        ],
      }),
    )
    const requested = await runCli(['csr', '--nodes', configPath, '--out-dir', csrDir])
    expect(requested.code).toBe(0)

    for (const cn of ['node1', 'node2']) {
      const csrPem = await readFile(join(csrDir, cn, `${cn}.csr`), 'utf-8')
      await writeFile(
        join(workDir, `${cn}.crt`),
        signRequestAsExternalAuthority(csrPem, companyCa.certPem, companyCa.keyPem),
      )

      const verified = await runCli([
        'verify',
        '--cert',
        join(workDir, `${cn}.crt`),
        '--key',
        join(csrDir, cn, `${cn}.key`),
        '--ca-cert',
        companyCa.certPath,
      ])
      expect(verified.code).toBe(0)
    }

    const node1 = await loadIdentity(join(workDir, 'node1.crt'), join(csrDir, 'node1', 'node1.key'))
    const node2 = await loadIdentity(join(workDir, 'node2.crt'), join(csrDir, 'node2', 'node2.key'))
    const exchange = await performMutualTlsHandshake({
      server: { ca: companyCa.certPem, cert: node1.certPem, key: node1.keyPem },
      client: { ca: companyCa.certPem, cert: node2.certPem, key: node2.keyPem },
    })
    expect(exchange.clientAuthorized).toBe(true)
    expect(exchange.serverAuthorized).toBe(true)
  })
})
