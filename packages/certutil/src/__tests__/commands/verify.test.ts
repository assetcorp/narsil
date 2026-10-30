import { X509Certificate } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import forge from 'node-forge'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Authority,
  createAuthority,
  createWorkspace,
  expectNoPrivateKeyInOutput,
  issueNodeCertificate,
  type NodeIdentity,
  parseEnvelope,
  removeWorkspace,
  runCli,
} from '../support/cli'

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

interface VerifyData {
  certKeyMatch: boolean | null
  chainValid: boolean | null
  notExpired: boolean
  keyUsageCorrect: boolean
  mtlsReady: boolean
  errors: string[]
}

function buildExpiredCertificatePem(authority: Authority): string {
  const certificate = forge.pki.createCertificate()
  certificate.publicKey = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 }).publicKey
  certificate.serialNumber = '01'
  certificate.validity.notBefore = new Date(Date.now() - 2 * MILLISECONDS_PER_DAY)
  certificate.validity.notAfter = new Date(Date.now() - MILLISECONDS_PER_DAY)
  certificate.setSubject([{ name: 'commonName', value: 'expired-node' }])
  certificate.setIssuer(forge.pki.certificateFromPem(authority.certPem).subject.attributes)
  certificate.setExtensions([
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
  ])
  certificate.sign(forge.pki.privateKeyFromPem(authority.keyPem), forge.md.sha256.create())
  return forge.pki.certificateToPem(certificate)
}

function tamperWithSignature(pem: string): string {
  const der = Buffer.from(new X509Certificate(pem).raw)
  const lastIndex = der.length - 1
  der.writeUInt8(der.readUInt8(lastIndex) ^ 0xff, lastIndex)
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`
}

describe('narsil-certutil verify', () => {
  let root: string
  let authority: Authority
  let node: NodeIdentity
  let otherNode: NodeIdentity

  beforeAll(async () => {
    root = await createWorkspace()
    const pkiDir = await createWorkspace(root)
    authority = await createAuthority(pkiDir, 'Verify Test CA')
    node = await issueNodeCertificate(authority, pkiDir, 'verify-node', ['--ip', '10.0.0.1'])
    otherNode = await issueNodeCertificate(authority, pkiDir, 'other-node')
  })

  afterAll(async () => {
    await removeWorkspace(root)
  })

  async function verifyJson(args: string[]): Promise<{ code: number; data: VerifyData | null }> {
    const result = await runCli(['verify', ...args, '--output', 'json'])
    expectNoPrivateKeyInOutput(result)
    return { code: result.code, data: parseEnvelope<VerifyData>(result.stdout).data }
  }

  it('passes a matching certificate, key, and CA with exit code 0', async () => {
    const { code, data } = await verifyJson([
      '--cert',
      node.certPath,
      '--key',
      node.keyPath,
      '--ca-cert',
      authority.certPath,
    ])

    expect(code).toBe(0)
    expect(data).toEqual({
      certKeyMatch: true,
      chainValid: true,
      notExpired: true,
      keyUsageCorrect: true,
      mtlsReady: true,
      errors: [],
    })
  })

  it('prints a readable pass and FAIL report in text mode', async () => {
    const passed = await runCli(['verify', '--cert', node.certPath, '--key', node.keyPath])
    const failed = await runCli(['verify', '--cert', node.certPath, '--key', otherNode.keyPath])

    expect(passed.code).toBe(0)
    expect(passed.stdout).toContain('pass  Certificate matches private key')
    expect(failed.code).toBe(1)
    expect(failed.stdout).toContain('FAIL  Certificate does NOT match private key')
  })

  it('fails with exit code 1 when the key belongs to another certificate', async () => {
    const { code, data } = await verifyJson(['--cert', node.certPath, '--key', otherNode.keyPath])

    expect(node.certificate.checkPrivateKey(otherNode.privateKey)).toBe(false)
    expect(code).toBe(1)
    expect(data?.certKeyMatch).toBe(false)
    expect(data?.errors).toContain('Certificate does not match private key')
  })

  it('fails a certificate from a different CA that has the same name as the trusted CA', async () => {
    const impostorDir = await createWorkspace(root)
    const impostor = await createAuthority(impostorDir, 'Verify Test CA')
    const forged = await issueNodeCertificate(impostor, impostorDir, 'verify-node')

    const { code, data } = await verifyJson(['--cert', forged.certPath, '--ca-cert', authority.certPath])

    expect(forged.certificate.verify(authority.certificate.publicKey)).toBe(false)
    expect(code).toBe(1)
    expect(data?.chainValid).toBe(false)
  })

  it('fails a certificate whose signature bytes were altered', async () => {
    const tamperedPath = join(await createWorkspace(root), 'tampered.crt')
    const tampered = tamperWithSignature(node.certPem)
    await writeFile(tamperedPath, tampered)

    const { code, data } = await verifyJson(['--cert', tamperedPath, '--ca-cert', authority.certPath])

    expect(new X509Certificate(tampered).verify(authority.certificate.publicKey)).toBe(false)
    expect(code).toBe(1)
    expect(data?.chainValid).toBe(false)
  })

  it('fails an expired certificate even when its chain is valid', async () => {
    const expiredPath = join(await createWorkspace(root), 'expired.crt')
    const expired = buildExpiredCertificatePem(authority)
    await writeFile(expiredPath, expired)

    const { code, data } = await verifyJson(['--cert', expiredPath, '--ca-cert', authority.certPath])

    expect(Date.parse(new X509Certificate(expired).validTo)).toBeLessThan(Date.now())
    expect(code).toBe(1)
    expect(data?.notExpired).toBe(false)
    expect(data?.chainValid).toBe(true)
    expect(data?.errors).toContain('Certificate is expired')
  })

  it('fails a CA certificate presented as a node certificate because it lacks mTLS usage', async () => {
    const { code, data } = await verifyJson(['--cert', authority.certPath])

    expect(code).toBe(1)
    expect(data?.mtlsReady).toBe(false)
    expect(data?.keyUsageCorrect).toBe(false)
  })

  it('refuses corrupted, truncated, empty, and absent inputs with exit code 1', async () => {
    const dir = await createWorkspace(root)
    const corruptPath = join(dir, 'corrupt.pem')
    const truncatedPath = join(dir, 'truncated.pem')
    const emptyPath = join(dir, 'empty.pem')
    const absentPath = join(dir, 'absent.pem')
    await writeFile(corruptPath, '-----BEGIN CERTIFICATE-----\nDEFINITELYNOTVALID\n-----END CERTIFICATE-----\n')
    await writeFile(truncatedPath, node.certPem.slice(0, Math.floor(node.certPem.length / 2)))
    await writeFile(emptyPath, '')

    const invocations = [corruptPath, truncatedPath, emptyPath, absentPath].flatMap(path => [
      ['--cert', path],
      ['--cert', node.certPath, '--key', path],
      ['--cert', node.certPath, '--ca-cert', path],
    ])

    for (const args of invocations) {
      const result = await runCli(['verify', ...args])

      expect(result.code, args.join(' ')).toBe(1)
      expect(result.stdout, args.join(' ')).toBe('')
      expect(result.stderr, args.join(' ')).toContain('Error:')
      expect(result.stderr, args.join(' ')).not.toContain('    at ')
    }
  })

  it('reports malformed input as a parsable JSON error envelope on stderr', async () => {
    const corruptPath = join(await createWorkspace(root), 'corrupt.pem')
    await writeFile(corruptPath, '-----BEGIN CERTIFICATE-----\nDEFINITELYNOTVALID\n-----END CERTIFICATE-----\n')

    const result = await runCli(['verify', '--cert', corruptPath, '--output', 'json'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    const envelope = parseEnvelope<null>(result.stderr)
    expect(envelope.status).toBe('error')
    expect(envelope.error?.code).toBe('GENERAL_ERROR')
  })
})
