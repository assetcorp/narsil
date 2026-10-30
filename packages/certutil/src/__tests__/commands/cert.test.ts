import { createPrivateKey, X509Certificate } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Authority,
  commonName,
  createAuthority,
  createWorkspace,
  daysUntilExpiry,
  expectNoPrivateKeyInOutput,
  expectRefusal,
  issueNodeCertificate,
  listFiles,
  loadIdentity,
  modulusBits,
  parseEnvelope,
  removeWorkspace,
  runCli,
  subjectAlternativeNames,
} from '../support/cli'

const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1'
const CLIENT_AUTH_OID = '1.3.6.1.5.5.7.3.2'

describe('narsil-certutil cert', () => {
  let root: string
  let authority: Authority

  beforeAll(async () => {
    root = await createWorkspace()
    authority = await createAuthority(await createWorkspace(root), 'Cert Test CA')
  })

  afterAll(async () => {
    await removeWorkspace(root)
  })

  function certArgs(cn: string, outDir: string): string[] {
    return ['cert', '--cn', cn, '--ca-cert', authority.certPath, '--ca-key', authority.keyPath, '--out-dir', outDir]
  }

  it('issues a leaf certificate that chains to the CA and carries the requested names and validity', async () => {
    const outDir = await createWorkspace(root)

    const { certificate, privateKey } = await issueNodeCertificate(authority, outDir, 'node1', [
      '--ip',
      '10.0.0.1',
      '192.168.1.100',
      '--dns',
      'node1.cluster.local',
      'node1.internal',
      '--days',
      '30',
    ])

    expect(commonName(certificate.subject)).toBe('node1')
    expect(commonName(certificate.issuer)).toBe('Cert Test CA')
    expect(certificate.checkIssued(authority.certificate)).toBe(true)
    expect(certificate.verify(authority.certificate.publicKey)).toBe(true)
    expect(certificate.checkPrivateKey(privateKey)).toBe(true)
    expect(certificate.ca).toBe(false)
    expect(certificate.keyUsage).toEqual(expect.arrayContaining([SERVER_AUTH_OID, CLIENT_AUTH_OID]))
    expect(subjectAlternativeNames(certificate)).toEqual([
      'DNS:node1.cluster.local',
      'DNS:node1.internal',
      'IP Address:10.0.0.1',
      'IP Address:192.168.1.100',
    ])
    expect(certificate.checkIP('10.0.0.1')).toBe('10.0.0.1')
    expect(certificate.checkHost('node1.internal')).toBe('node1.internal')
    expect(certificate.checkHost('node2.internal')).toBeUndefined()
    expect(daysUntilExpiry(certificate)).toBe(30)
    expect(modulusBits(privateKey)).toBe(2048)
  })

  it('accepts an IPv6 address as a subject alternative name', async () => {
    const { certificate } = await issueNodeCertificate(authority, await createWorkspace(root), 'node6', ['--ip', '::1'])

    expect(certificate.checkIP('::1')).toBe('::1')
  })

  it('gives every certificate its own key and serial number, even for one common name', async () => {
    const first = await issueNodeCertificate(authority, await createWorkspace(root), 'same-name')
    const second = await issueNodeCertificate(authority, await createWorkspace(root), 'same-name')

    expect(first.certificate.serialNumber).not.toBe(second.certificate.serialNumber)
    expect(first.certificate.fingerprint256).not.toBe(second.certificate.fingerprint256)
    expect(first.certificate.checkPrivateKey(second.privateKey)).toBe(false)
  })

  it('reports the fingerprint in a parsable JSON envelope and keeps the private key out of it', async () => {
    const outDir = await createWorkspace(root)

    const result = await runCli([...certArgs('json-node', outDir), '--output', 'json'])

    expect(result.code).toBe(0)
    expectNoPrivateKeyInOutput(result)
    const envelope = parseEnvelope<{ fingerprint: string; expiresAt: string }>(result.stdout)
    const certificate = new X509Certificate(await readFile(join(outDir, 'json-node.crt')))
    expect(envelope.status).toBe('success')
    expect(envelope.data?.fingerprint).toBe(certificate.fingerprint256)
    expect(Date.parse(envelope.data?.expiresAt ?? '')).toBe(Date.parse(certificate.validTo))
  })

  it('reads the CA paths from the environment and writes to the working directory by default', async () => {
    const cwd = await createWorkspace(root)

    const result = await runCli(['cert', '--cn', 'env-node'], {
      cwd,
      env: { NARSIL_CA_CERT: authority.certPath, NARSIL_CA_KEY: authority.keyPath },
    })

    expect(result.code).toBe(0)
    expect(await listFiles(cwd)).toEqual(['env-node.crt', 'env-node.key'])
  })

  it('signs with a CA key in PKCS#8 form', async () => {
    const outDir = await createWorkspace(root)
    const pkcs8Path = join(outDir, 'ca-pkcs8.key')
    const pkcs8 = createPrivateKey(authority.keyPem).export({ type: 'pkcs8', format: 'pem' })
    await writeFile(pkcs8Path, pkcs8)

    const result = await runCli([
      'cert',
      '--cn',
      'pkcs8-node',
      '--ca-cert',
      authority.certPath,
      '--ca-key',
      pkcs8Path,
      '--out-dir',
      outDir,
    ])

    expect(result.code).toBe(0)
    const certificate = new X509Certificate(await readFile(join(outDir, 'pkcs8-node.crt')))
    expect(certificate.verify(authority.certificate.publicKey)).toBe(true)
  })

  it('leaves an existing certificate untouched without --force and replaces it with --force', async () => {
    const outDir = await createWorkspace(root)
    const original = await issueNodeCertificate(authority, outDir, 'node1')

    const refused = await runCli(certArgs('node1', outDir))

    expectRefusal(refused, 1, /File already exists.*--force/)
    expect(await readFile(original.certPath, 'utf-8')).toBe(original.certPem)
    expect(await readFile(original.keyPath, 'utf-8')).toBe(original.keyPem)

    const forced = await runCli([...certArgs('node1', outDir), '--force'])

    expect(forced.code).toBe(0)
    const replacement = await loadIdentity(original.certPath, original.keyPath)
    expect(replacement.certificate.fingerprint256).not.toBe(original.certificate.fingerprint256)
    expect(replacement.certificate.checkPrivateKey(replacement.privateKey)).toBe(true)
  })

  it('writes nothing in a dry run', async () => {
    const outDir = join(await createWorkspace(root), 'never-created')

    const result = await runCli([...certArgs('dry-node', outDir), '--dry-run'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(join(outDir, 'dry-node.key'))
    expect(await listFiles(outDir)).toEqual([])
  })

  it.each([
    ['--days', '0', 2, /Invalid --days/],
    ['--days', 'soon', 2, /Invalid --days/],
    ['--key-size', '512', 2, /Invalid --key-size/],
    ['--ip', 'not-an-ip', 1, /Invalid IP address/],
  ])('refuses %s %s and writes nothing', async (flag, value, code, message) => {
    const outDir = await createWorkspace(root)

    const result = await runCli([...certArgs('bad-node', outDir), flag, value])

    expectRefusal(result, code, message)
    expect(await listFiles(outDir)).toEqual([])
  })

  it('refuses a request with neither --cn nor --nodes', async () => {
    const result = await runCli(['cert', '--ca-cert', authority.certPath, '--ca-key', authority.keyPath])

    expectRefusal(result, 2, /--cn or --nodes/)
  })

  it('refuses a request without CA paths', async () => {
    const result = await runCli(['cert', '--cn', 'no-ca-node'])

    expectRefusal(result, 1, /--ca-cert/)
  })

  it('refuses a CA file that does not exist', async () => {
    const outDir = await createWorkspace(root)

    const result = await runCli([
      'cert',
      '--cn',
      'node',
      '--ca-cert',
      join(outDir, 'absent.crt'),
      '--ca-key',
      authority.keyPath,
      '--out-dir',
      outDir,
    ])

    expectRefusal(result, 1, /File not found for --ca-cert/)
    expect(await listFiles(outDir)).toEqual([])
  })

  it('refuses unusable CA keys and leaves no certificate behind', async () => {
    const outDir = await createWorkspace(root)
    const encrypted = createPrivateKey(authority.keyPem).export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: 'operator-passphrase',
    })
    const unusableKeys: Array<[string, string | Buffer, RegExp]> = [
      ['garbage.key', '-----BEGIN RSA PRIVATE KEY-----\nGARBAGE\n-----END RSA PRIVATE KEY-----\n', /./],
      ['certificate-as-key.key', authority.certPem, /PEM header type/],
      ['encrypted.key', encrypted, /PEM header type/],
      ['empty.key', '', /./],
    ]

    for (const [name, content, message] of unusableKeys) {
      const keyPath = join(outDir, name)
      await writeFile(keyPath, content)
      const nodeDir = join(outDir, `out-${name}`)

      const result = await runCli([
        'cert',
        '--cn',
        'node',
        '--ca-cert',
        authority.certPath,
        '--ca-key',
        keyPath,
        '--out-dir',
        nodeDir,
      ])

      expectRefusal(result, 1, message)
      expectNoPrivateKeyInOutput(result)
      expect(await listFiles(nodeDir)).toEqual([])
    }
  })

  it('refuses a corrupted CA certificate', async () => {
    const outDir = await createWorkspace(root)
    const corruptPath = join(outDir, 'corrupt.crt')
    await writeFile(corruptPath, '-----BEGIN CERTIFICATE-----\nDEFINITELYNOTVALID\n-----END CERTIFICATE-----\n')
    const nodeDir = join(outDir, 'out')

    const result = await runCli([
      'cert',
      '--cn',
      'node',
      '--ca-cert',
      corruptPath,
      '--ca-key',
      authority.keyPath,
      '--out-dir',
      nodeDir,
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Error:')
    expect(await listFiles(nodeDir)).toEqual([])
  })
})
