import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'
import { runVerifyAction } from '../../commands/verify'
import { generateCaCertificate } from '../../crypto/ca'
import { generateNodeCertificate } from '../../crypto/certificate'
import { buildNodeExtensions } from '../../crypto/extensions'
import { pemToCertificate } from '../../crypto/pem'
import { ensureDirectory } from '../../output/writer'

describe('generateNodeCertificate', () => {
  const ca = generateCaCertificate({ name: 'Test CA', days: 3650, keySize: 2048 })

  const nodeResult = generateNodeCertificate({
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    cn: 'narsil-node-01',
    ipSans: ['192.168.1.10', '127.0.0.1'],
    dnsSans: ['node01.narsil.local'],
    days: 365,
    keySize: 2048,
  })

  it('is signed by the CA, verifiable through the chain', () => {
    const caCert = pemToCertificate(ca.certPem)
    const nodeCert = pemToCertificate(nodeResult.certPem)
    const caStore = forge.pki.createCaStore([caCert])
    expect(() => forge.pki.verifyCertificateChain(caStore, [nodeCert])).not.toThrow()
  })

  it('has the correct subject CN', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    expect(cert.subject.getField('CN').value).toBe('narsil-node-01')
  })

  it('has the issuer CN matching the CA', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    expect(cert.issuer.getField('CN').value).toBe('Test CA')
  })

  it('contains the requested IP SANs', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    const san = cert.getExtension('subjectAltName') as { altNames?: Array<{ type: number; ip?: string }> } | null
    const ipEntries = san?.altNames?.filter(e => e.type === 7).map(e => e.ip) ?? []
    expect(ipEntries).toContain('192.168.1.10')
    expect(ipEntries).toContain('127.0.0.1')
  })

  it('contains the requested DNS SANs', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    const san = cert.getExtension('subjectAltName') as { altNames?: Array<{ type: number; value?: string }> } | null
    const dnsEntries = san?.altNames?.filter(e => e.type === 2).map(e => e.value) ?? []
    expect(dnsEntries).toContain('node01.narsil.local')
  })

  it('has extKeyUsage with serverAuth and clientAuth for mTLS', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    const eku = cert.getExtension('extKeyUsage') as { serverAuth?: boolean; clientAuth?: boolean } | null
    expect(eku?.serverAuth).toBe(true)
    expect(eku?.clientAuth).toBe(true)
  })

  it('is NOT a CA certificate', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    const bc = cert.getExtension('basicConstraints') as { cA?: boolean } | null
    expect(bc?.cA).toBe(false)
  })

  it('produces a valid fingerprint', () => {
    const parts = nodeResult.fingerprint.split(':')
    expect(parts.length).toBe(32)
  })

  it('throws for invalid validity periods', () => {
    expect(() =>
      generateNodeCertificate({
        caCertPem: ca.certPem,
        caKeyPem: ca.keyPem,
        cn: 'bad',
        ipSans: [],
        dnsSans: [],
        days: 0,
        keySize: 2048,
      }),
    ).toThrow('Invalid validity period')
  })
})

describe('expired certificate detection', () => {
  const ca = generateCaCertificate({ name: 'Expiry Test CA', days: 3650, keySize: 2048 })
  const nodeResult = generateNodeCertificate({
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    cn: 'expiry-node',
    ipSans: ['10.0.0.1'],
    dnsSans: ['expiry-node.cluster.local'],
    days: 365,
    keySize: 2048,
  })

  let dir: string
  let originalExitCode: string | number | null | undefined
  let stdoutChunks: string[]
  let stderrChunks: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dir = join(tmpdir(), `certutil-expired-cert-${randomBytes(8).toString('hex')}`)
    await ensureDirectory(dir)
    originalExitCode = process.exitCode
    stdoutChunks = []
    stderrChunks = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk))
      return true
    })
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk))
      return true
    })
  })

  afterEach(async () => {
    process.exitCode = originalExitCode
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    await rm(dir, { recursive: true, force: true })
  })

  it('detects an expired certificate via the verify command', async () => {
    const caCert = pemToCertificate(ca.certPem)
    const caKey = forge.pki.privateKeyFromPem(ca.keyPem)

    const expiredCert = forge.pki.createCertificate()
    expiredCert.publicKey = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 }).publicKey
    expiredCert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16))

    const twoDaysAgo = new Date()
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)
    const oneDayAgo = new Date()
    oneDayAgo.setDate(oneDayAgo.getDate() - 1)

    expiredCert.validity.notBefore = twoDaysAgo
    expiredCert.validity.notAfter = oneDayAgo

    expiredCert.setSubject([{ name: 'commonName', value: 'expired-node' }])
    expiredCert.setIssuer(caCert.subject.attributes)
    expiredCert.setExtensions(buildNodeExtensions(['10.0.0.99'], ['expired.cluster.local']))
    expiredCert.sign(caKey, forge.md.sha256.create())

    const expiredPem = forge.pki.certificateToPem(expiredCert)
    const certPath = join(dir, 'expired.crt')
    await writeFile(certPath, expiredPem)

    await runVerifyAction({ cert: certPath, output: 'json' })

    const stdout = stdoutChunks.join('')
    const envelope = JSON.parse(stdout)
    expect(envelope.data.notExpired).toBe(false)
    expect(envelope.data.errors).toContain('Certificate is expired')
    expect(process.exitCode).toBe(1)
  })

  it('confirms a valid certificate is not expired', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    expect(cert.validity.notAfter.getTime() > Date.now()).toBe(true)
  })
})
