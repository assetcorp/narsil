import { createPrivateKey } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
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
  modulusBits,
  type NodeIdentity,
  parseEnvelope,
  removeWorkspace,
  runCli,
} from '../support/cli'

interface InspectData {
  type: string
  subject?: Record<string, string>
  issuer?: Record<string, string>
  validFrom?: string
  validTo?: string
  expiresInDays?: number
  ipSans?: string[]
  dnsSans?: string[]
  keyUsage?: string[]
  extKeyUsage?: string[]
  fingerprint?: string
  publicKeyBits?: number
}

describe('narsil-certutil inspect', () => {
  let root: string
  let pkiDir: string
  let authority: Authority
  let node: NodeIdentity

  beforeAll(async () => {
    root = await createWorkspace()
    pkiDir = await createWorkspace(root)
    authority = await createAuthority(pkiDir, 'Inspect Test CA')
    node = await issueNodeCertificate(authority, pkiDir, 'inspect-node', [
      '--ip',
      '10.0.0.5',
      '--dns',
      'inspect-node.cluster.local',
      '--days',
      '90',
    ])
  })

  afterAll(async () => {
    await removeWorkspace(root)
  })

  async function inspectJson(path: string): Promise<InspectData | null> {
    const result = await runCli(['inspect', path, '--output', 'json'])
    expect(result.code).toBe(0)
    expectNoPrivateKeyInOutput(result)
    return parseEnvelope<InspectData>(result.stdout).data
  }

  it('reports the same certificate facts that node:crypto reads', async () => {
    const data = await inspectJson(node.certPath)
    const { certificate } = node

    expect(data?.type).toBe('certificate')
    expect(data?.subject?.CN).toBe(commonName(certificate.subject))
    expect(data?.issuer?.CN).toBe(commonName(certificate.issuer))
    expect(Date.parse(data?.validFrom ?? '')).toBe(Date.parse(certificate.validFrom))
    expect(Date.parse(data?.validTo ?? '')).toBe(Date.parse(certificate.validTo))
    expect(Math.abs((data?.expiresInDays ?? 0) - daysUntilExpiry(certificate))).toBeLessThanOrEqual(1)
    expect(data?.fingerprint).toBe(certificate.fingerprint256)
    expect(data?.publicKeyBits).toBe(modulusBits(certificate.publicKey))
    expect(data?.ipSans).toEqual(['10.0.0.5'])
    expect(data?.dnsSans).toEqual(['inspect-node.cluster.local'])
    expect(data?.keyUsage).toEqual(['digitalSignature', 'keyEncipherment'])
    expect(data?.extKeyUsage).toEqual(['serverAuth', 'clientAuth'])
  })

  it('reports the signing usages of a CA certificate', async () => {
    const data = await inspectJson(authority.certPath)

    expect(data?.issuer).toEqual(data?.subject)
    expect(data?.keyUsage).toEqual(expect.arrayContaining(['keyCertSign', 'cRLSign']))
    expect(data?.fingerprint).toBe(authority.certificate.fingerprint256)
  })

  it('prints a readable certificate report in text mode', async () => {
    const result = await runCli(['inspect', node.certPath])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('CN=inspect-node')
    expect(result.stdout).toContain('CN=Inspect Test CA')
    expect(result.stdout).toContain('10.0.0.5')
    expect(result.stdout).toContain('inspect-node.cluster.local')
    expect(result.stdout).toContain(`SHA256:${node.certificate.fingerprint256}`)
  })

  it('reports the names in a CSR and the size of its key', async () => {
    const outDir = await createWorkspace(root)
    const generated = await runCli([
      'csr',
      '--cn',
      'csr-node',
      '--ip',
      '10.0.0.6',
      '--dns',
      'csr.local',
      '--out-dir',
      outDir,
    ])
    expect(generated.code).toBe(0)

    const data = await inspectJson(join(outDir, 'csr-node.csr'))

    expect(data?.type).toBe('csr')
    expect(data?.subject?.CN).toBe('csr-node')
    expect(data?.ipSans).toEqual(['10.0.0.6'])
    expect(data?.dnsSans).toEqual(['csr.local'])
    expect(data?.publicKeyBits).toBe(2048)
  })

  it('reports only the size of a private key, in PKCS#1 and PKCS#8 form, and never its material', async () => {
    const pkcs8Path = join(await createWorkspace(root), 'pkcs8.key')
    await writeFile(pkcs8Path, createPrivateKey(node.keyPem).export({ type: 'pkcs8', format: 'pem' }))
    const keyBody = node.keyPem.split('\n')[1] ?? ''

    for (const path of [node.keyPath, pkcs8Path]) {
      const text = await runCli(['inspect', path])
      const json = await runCli(['inspect', path, '--output', 'json'])

      expect(text.code).toBe(0)
      expect(text.stdout).toContain('2048-bit RSA')
      expect(text.stdout).not.toContain(keyBody)
      expect(parseEnvelope<InspectData>(json.stdout).data).toEqual({ type: 'key', publicKeyBits: 2048 })
    }
  })

  it.each([
    ['plain text', 'not a PEM file at all'],
    ['an empty file', ''],
    ['binary bytes', Buffer.from([0x00, 0x01, 0xff, 0xfe])],
    ['an unknown PEM type', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n'],
  ])('refuses %s with exit code 2', async (_label, content) => {
    const path = join(await createWorkspace(root), 'input.pem')
    await writeFile(path, content)

    const text = await runCli(['inspect', path])
    const json = await runCli(['inspect', path, '--output', 'json'])

    expectRefusal(text, 2, /Unrecognized PEM format/)
    expect(json.code).toBe(2)
    expect(json.stdout).toBe('')
    expect(parseEnvelope<null>(json.stderr).error?.code).toBe('BAD_ARGUMENTS')
  })

  it('refuses a recognised header over a corrupted body with exit code 1', async () => {
    const dir = await createWorkspace(root)
    const inputs = [
      '-----BEGIN CERTIFICATE-----\nDEFINITELYNOTVALID\n-----END CERTIFICATE-----\n',
      '-----BEGIN RSA PRIVATE KEY-----\nGARBAGE\n-----END RSA PRIVATE KEY-----\n',
      '-----BEGIN CERTIFICATE REQUEST-----\nGARBAGE\n-----END CERTIFICATE REQUEST-----\n',
    ]

    for (const [index, content] of inputs.entries()) {
      const path = join(dir, `corrupt-${index}.pem`)
      await writeFile(path, content)

      const result = await runCli(['inspect', path])

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Error:')
      expect(result.stderr).not.toContain('    at ')
    }
  })

  it('keeps the material of a truncated private key out of its error', async () => {
    const path = join(await createWorkspace(root), 'truncated.key')
    const lines = node.keyPem.split('\n').slice(0, 6)
    await writeFile(path, lines.join('\n'))

    const result = await runCli(['inspect', path])

    expect(result.code).toBe(1)
    for (const line of lines.slice(1)) {
      expect(result.stderr).not.toContain(line)
    }
  })

  it('refuses an encrypted private key because it holds no passphrase', async () => {
    const path = join(await createWorkspace(root), 'encrypted.key')
    const encrypted = createPrivateKey(node.keyPem).export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: 'operator-passphrase',
    })
    await writeFile(path, encrypted)

    const result = await runCli(['inspect', path])

    expectRefusal(result, 1, /PEM header type/)
  })

  it('refuses a file that does not exist with a parsable JSON error', async () => {
    const path = join(await createWorkspace(root), 'absent.pem')

    const result = await runCli(['inspect', path, '--output', 'json'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(parseEnvelope<null>(result.stderr).error?.message).toContain('ENOENT')
  })
})
