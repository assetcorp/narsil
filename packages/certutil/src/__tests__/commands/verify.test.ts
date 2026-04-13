import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runVerifyAction } from '../../commands/verify'
import { generateCaCertificate } from '../../crypto/ca'
import { generateNodeCertificate } from '../../crypto/certificate'
import { ensureDirectory } from '../../output/writer'

function tempDir(): string {
  return join(tmpdir(), `certutil-verify-cmd-test-${randomBytes(8).toString('hex')}`)
}

const ca = generateCaCertificate({ name: 'Verify Test CA', days: 3650, keySize: 2048 })
const otherCa = generateCaCertificate({ name: 'Other CA', days: 3650, keySize: 2048 })

const nodeCert = generateNodeCertificate({
  caCertPem: ca.certPem,
  caKeyPem: ca.keyPem,
  cn: 'verify-node',
  ipSans: ['10.0.0.1'],
  dnsSans: ['verify-node.cluster.local'],
  days: 365,
  keySize: 2048,
})

describe('verify command', () => {
  let dir: string
  let originalExitCode: string | number | null | undefined
  let stderrChunks: string[]
  let stdoutChunks: string[]
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dir = tempDir()
    await ensureDirectory(dir)
    await writeFile(join(dir, 'ca.crt'), ca.certPem)
    await writeFile(join(dir, 'other-ca.crt'), otherCa.certPem)
    await writeFile(join(dir, 'node.crt'), nodeCert.certPem)
    await writeFile(join(dir, 'node.key'), nodeCert.keyPem)
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

  it('verifies a valid cert+key pair matches', async () => {
    await runVerifyAction({
      cert: join(dir, 'node.crt'),
      key: join(dir, 'node.key'),
      output: 'text',
    })

    const stdout = stdoutChunks.join('')
    expect(stdout).toContain('pass')
    expect(stdout).toContain('Certificate matches private key')
  })

  it('detects a cert+wrong-key mismatch', async () => {
    const wrongKey = generateNodeCertificate({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      cn: 'other-node',
      ipSans: [],
      dnsSans: [],
      days: 365,
      keySize: 2048,
    })
    await writeFile(join(dir, 'wrong.key'), wrongKey.keyPem)

    await runVerifyAction({
      cert: join(dir, 'node.crt'),
      key: join(dir, 'wrong.key'),
      output: 'text',
    })

    expect(process.exitCode).toBe(1)
    const stdout = stdoutChunks.join('')
    expect(stdout).toContain('FAIL')
    expect(stdout).toContain('does NOT match')
  })

  it('validates the certificate chain against the correct CA', async () => {
    await runVerifyAction({
      cert: join(dir, 'node.crt'),
      caCert: join(dir, 'ca.crt'),
      output: 'text',
    })

    const stdout = stdoutChunks.join('')
    expect(stdout).toContain('pass')
    expect(stdout).toContain('validates against CA')
  })

  it('detects chain failure against the wrong CA', async () => {
    await runVerifyAction({
      cert: join(dir, 'node.crt'),
      caCert: join(dir, 'other-ca.crt'),
      output: 'text',
    })

    expect(process.exitCode).toBe(1)
    const stdout = stdoutChunks.join('')
    expect(stdout).toContain('FAIL')
    expect(stdout).toContain('does NOT validate')
  })

  it('confirms the node cert has correct key usage for mTLS', async () => {
    await runVerifyAction({
      cert: join(dir, 'node.crt'),
      output: 'text',
    })

    const stdout = stdoutChunks.join('')
    expect(stdout).toContain('pass')
    expect(stdout).toContain('digitalSignature')
    expect(stdout).toContain('keyEncipherment')
    expect(stdout).toContain('mTLS')
    expect(stdout).toContain('serverAuth')
    expect(stdout).toContain('clientAuth')
  })

  it('detects missing mTLS readiness on a CA cert (no extKeyUsage)', async () => {
    await runVerifyAction({
      cert: join(dir, 'ca.crt'),
      output: 'text',
    })

    expect(process.exitCode).toBe(1)
    const stdout = stdoutChunks.join('')
    expect(stdout).toContain('FAIL')
    expect(stdout).toContain('NOT ready for Narsil mTLS')
  })

  it('outputs JSON envelope in json mode', async () => {
    await runVerifyAction({
      cert: join(dir, 'node.crt'),
      key: join(dir, 'node.key'),
      caCert: join(dir, 'ca.crt'),
      output: 'json',
    })

    const stdout = stdoutChunks.join('')
    const envelope = JSON.parse(stdout)
    expect(envelope.status).toBe('success')
    expect(envelope.data.certKeyMatch).toBe(true)
    expect(envelope.data.chainValid).toBe(true)
    expect(envelope.data.notExpired).toBe(true)
    expect(envelope.data.keyUsageCorrect).toBe(true)
    expect(envelope.data.mtlsReady).toBe(true)
    expect(envelope.data.errors).toHaveLength(0)
  })

  it('reports all failures in JSON mode', async () => {
    const wrongKey = generateNodeCertificate({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      cn: 'fail-node',
      ipSans: [],
      dnsSans: [],
      days: 365,
      keySize: 2048,
    })
    await writeFile(join(dir, 'wrong2.key'), wrongKey.keyPem)

    await runVerifyAction({
      cert: join(dir, 'node.crt'),
      key: join(dir, 'wrong2.key'),
      caCert: join(dir, 'other-ca.crt'),
      output: 'json',
    })

    const stdout = stdoutChunks.join('')
    const envelope = JSON.parse(stdout)
    expect(envelope.data.certKeyMatch).toBe(false)
    expect(envelope.data.chainValid).toBe(false)
    expect(envelope.data.errors.length).toBeGreaterThanOrEqual(2)
  })

  it('runs full verification with all checks passing', async () => {
    await runVerifyAction({
      cert: join(dir, 'node.crt'),
      key: join(dir, 'node.key'),
      caCert: join(dir, 'ca.crt'),
      output: 'text',
    })

    expect(process.exitCode).not.toBe(1)
    const stdout = stdoutChunks.join('')
    expect(stdout).not.toContain('FAIL')
  })
})
