import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInspectAction } from '../../commands/inspect'
import { generateCaCertificate } from '../../crypto/ca'
import { generateNodeCertificate } from '../../crypto/certificate'
import { generateCsr } from '../../crypto/csr'
import { ensureDirectory } from '../../output/writer'

function tempDir(): string {
  return join(tmpdir(), `certutil-inspect-cmd-test-${randomBytes(8).toString('hex')}`)
}

const ca = generateCaCertificate({ name: 'Inspect Test CA', days: 3650, keySize: 2048 })

const nodeCert = generateNodeCertificate({
  caCertPem: ca.certPem,
  caKeyPem: ca.keyPem,
  cn: 'inspect-node',
  ipSans: ['10.0.0.5'],
  dnsSans: ['inspect-node.cluster.local'],
  days: 365,
  keySize: 2048,
})

const csr = generateCsr({
  cn: 'csr-node',
  ipSans: ['10.0.0.6'],
  dnsSans: ['csr-node.cluster.local'],
  keySize: 2048,
})

describe('inspect command', () => {
  let dir: string
  let originalExitCode: number | undefined
  let stderrChunks: string[]
  let stdoutChunks: string[]
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dir = tempDir()
    await ensureDirectory(dir)
    originalExitCode = process.exitCode
    stderrChunks = []
    stdoutChunks = []
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk))
      return true
    })
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk))
      return true
    })
  })

  afterEach(async () => {
    process.exitCode = originalExitCode
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    await rm(dir, { recursive: true, force: true })
  })

  it('inspects a certificate and shows subject, issuer, validity, SANs, and fingerprint', async () => {
    const certPath = join(dir, 'node.crt')
    await writeFile(certPath, nodeCert.certPem)

    await runInspectAction(certPath, { output: 'text' })

    const stdout = stdoutChunks.join('')
    expect(stdout).toContain('Type:')
    expect(stdout).toContain('certificate')
    expect(stdout).toContain('inspect-node')
    expect(stdout).toContain('Inspect Test CA')
    expect(stdout).toContain('Valid from')
    expect(stdout).toContain('Valid until')
    expect(stdout).toContain('IP SANs')
    expect(stdout).toContain('10.0.0.5')
    expect(stdout).toContain('DNS SANs')
    expect(stdout).toContain('inspect-node.cluster.local')
    expect(stdout).toContain('Fingerprint')
    expect(stdout).toContain('Key size')
    expect(stdout).toContain('2048-bit RSA')
    expect(stdout).toContain('digitalSignature')
    expect(stdout).toContain('keyEncipherment')
    expect(stdout).toContain('serverAuth')
    expect(stdout).toContain('clientAuth')
  })

  it('inspects a CA certificate showing self-signed issuer', async () => {
    const caPath = join(dir, 'ca.crt')
    await writeFile(caPath, ca.certPem)

    await runInspectAction(caPath, { output: 'text' })

    const stdout = stdoutChunks.join('')
    expect(stdout).toContain('Inspect Test CA')
    expect(stdout).toContain('keyCertSign')
    expect(stdout).toContain('cRLSign')
  })

  it('inspects a CSR and shows subject and SANs', async () => {
    const csrPath = join(dir, 'node.csr')
    await writeFile(csrPath, csr.csrPem)

    await runInspectAction(csrPath, { output: 'text' })

    const stdout = stdoutChunks.join('')
    expect(stdout).toContain('csr')
    expect(stdout).toContain('csr-node')
    expect(stdout).toContain('10.0.0.6')
    expect(stdout).toContain('csr-node.cluster.local')
  })

  it('inspects a private key and shows key size', async () => {
    const keyPath = join(dir, 'node.key')
    await writeFile(keyPath, nodeCert.keyPem)

    await runInspectAction(keyPath, { output: 'text' })

    const stdout = stdoutChunks.join('')
    expect(stdout).toContain('key')
    expect(stdout).toContain('2048-bit RSA')
  })

  it('outputs JSON envelope in json mode', async () => {
    const certPath = join(dir, 'json-cert.crt')
    await writeFile(certPath, nodeCert.certPem)

    await runInspectAction(certPath, { output: 'json' })

    const stdout = stdoutChunks.join('')
    const envelope = JSON.parse(stdout)
    expect(envelope.status).toBe('success')
    expect(envelope.data.type).toBe('certificate')
    expect(envelope.data.subject).toBeDefined()
    expect(envelope.data.issuer).toBeDefined()
    expect(envelope.data.fingerprint).toBeTruthy()
    expect(envelope.data.publicKeyBits).toBe(2048)
    expect(envelope.data.ipSans).toContain('10.0.0.5')
    expect(envelope.data.dnsSans).toContain('inspect-node.cluster.local')
    expect(envelope.data.keyUsage).toContain('digitalSignature')
    expect(envelope.data.extKeyUsage).toContain('serverAuth')
  })

  it('errors on unrecognized PEM format', async () => {
    const badPath = join(dir, 'garbage.pem')
    await writeFile(badPath, 'not a PEM file at all')

    await runInspectAction(badPath, { output: 'text' })

    expect(process.exitCode).toBe(2)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Unrecognized PEM format')
  })

  it('shows expires-in-days for a certificate', async () => {
    const certPath = join(dir, 'expires.crt')
    await writeFile(certPath, nodeCert.certPem)

    await runInspectAction(certPath, { output: 'json' })

    const stdout = stdoutChunks.join('')
    const envelope = JSON.parse(stdout)
    expect(envelope.data.expiresInDays).toBeGreaterThan(360)
    expect(envelope.data.expiresInDays).toBeLessThanOrEqual(365)
  })
})
