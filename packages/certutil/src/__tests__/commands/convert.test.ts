import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runConvertAction } from '../../commands/convert'
import { generateCaCertificate } from '../../crypto/ca'
import { generateNodeCertificate } from '../../crypto/certificate'
import { pemToPkcs12 } from '../../crypto/pkcs12'
import { ensureDirectory, fileExists } from '../../output/writer'

function tempDir(): string {
  return join(tmpdir(), `certutil-convert-cmd-test-${randomBytes(8).toString('hex')}`)
}

const ca = generateCaCertificate({ name: 'Convert Test CA', days: 3650, keySize: 2048 })
const nodeCert = generateNodeCertificate({
  caCertPem: ca.certPem,
  caKeyPem: ca.keyPem,
  cn: 'convert-node',
  ipSans: ['10.0.0.1'],
  dnsSans: ['convert-node.local'],
  days: 365,
  keySize: 2048,
})

describe('convert command', () => {
  let dir: string
  let originalExitCode: number | undefined
  let stderrChunks: string[]
  let stdoutChunks: string[]
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dir = tempDir()
    await ensureDirectory(dir)
    await writeFile(join(dir, 'cert.pem'), nodeCert.certPem)
    await writeFile(join(dir, 'key.pem'), nodeCert.keyPem)
    await writeFile(join(dir, 'ca.pem'), ca.certPem)
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

  it('converts PEM to PKCS#12', async () => {
    const outDir = join(dir, 'p12-out')
    await runConvertAction({
      cert: join(dir, 'cert.pem'),
      key: join(dir, 'key.pem'),
      caCert: join(dir, 'ca.pem'),
      to: 'p12',
      p12Password: 'test-password',
      outDir,
      output: 'text',
      force: false,
    })

    expect(await fileExists(join(outDir, 'certificate.p12'))).toBe(true)
    const p12Content = await readFile(join(outDir, 'certificate.p12'))
    expect(p12Content.length).toBeGreaterThan(0)

    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Converted files:')
    expect(stderr).toContain('certificate.p12')
  })

  it('converts PKCS#12 to PEM', async () => {
    const p12Bytes = pemToPkcs12(nodeCert.certPem, nodeCert.keyPem, 'test-password', ca.certPem)
    const p12Path = join(dir, 'input.p12')
    await writeFile(p12Path, p12Bytes)

    const outDir = join(dir, 'pem-out')
    await runConvertAction({
      p12: p12Path,
      to: 'pem',
      p12Password: 'test-password',
      outDir,
      output: 'text',
      force: false,
    })

    expect(await fileExists(join(outDir, 'cert.pem'))).toBe(true)
    expect(await fileExists(join(outDir, 'key.pem'))).toBe(true)

    const certContent = await readFile(join(outDir, 'cert.pem'), 'utf-8')
    expect(certContent).toContain('BEGIN CERTIFICATE')

    const keyContent = await readFile(join(outDir, 'key.pem'), 'utf-8')
    expect(keyContent).toContain('BEGIN RSA PRIVATE KEY')
  })

  it('round-trips PEM through PKCS#12 and back', async () => {
    const outP12 = join(dir, 'roundtrip-p12')
    await runConvertAction({
      cert: join(dir, 'cert.pem'),
      key: join(dir, 'key.pem'),
      to: 'p12',
      p12Password: 'roundtrip-pw',
      outDir: outP12,
      output: 'text',
      force: false,
    })

    const outPem = join(dir, 'roundtrip-pem')
    stderrChunks = []
    await runConvertAction({
      p12: join(outP12, 'certificate.p12'),
      to: 'pem',
      p12Password: 'roundtrip-pw',
      outDir: outPem,
      output: 'text',
      force: false,
    })

    const roundtrippedCert = await readFile(join(outPem, 'cert.pem'), 'utf-8')
    const roundtrippedKey = await readFile(join(outPem, 'key.pem'), 'utf-8')
    expect(roundtrippedCert).toContain('BEGIN CERTIFICATE')
    expect(roundtrippedKey).toContain('BEGIN RSA PRIVATE KEY')
  })

  it('errors when password is missing', async () => {
    await runConvertAction({
      cert: join(dir, 'cert.pem'),
      key: join(dir, 'key.pem'),
      to: 'p12',
      outDir: dir,
      output: 'text',
      force: false,
    })

    expect(process.exitCode).toBe(2)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Password is required')
  })

  it('errors when converting to p12 without --cert and --key', async () => {
    await runConvertAction({
      to: 'p12',
      p12Password: 'pw',
      outDir: dir,
      output: 'text',
      force: false,
    })

    expect(process.exitCode).toBe(1)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('requires --cert and --key')
  })

  it('errors when converting to pem without --p12', async () => {
    await runConvertAction({
      to: 'pem',
      p12Password: 'pw',
      outDir: dir,
      output: 'text',
      force: false,
    })

    expect(process.exitCode).toBe(1)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('requires --p12')
  })

  it('outputs JSON envelope in json mode for p12 conversion', async () => {
    const outDir = join(dir, 'json-p12')
    await runConvertAction({
      cert: join(dir, 'cert.pem'),
      key: join(dir, 'key.pem'),
      to: 'p12',
      p12Password: 'json-pw',
      outDir,
      output: 'json',
      force: false,
    })

    const stdout = stdoutChunks.join('')
    const envelope = JSON.parse(stdout)
    expect(envelope.status).toBe('success')
    expect(envelope.data.format).toBe('p12')
    expect(envelope.data.files).toHaveLength(1)
  })

  it('errors on invalid --to value', async () => {
    await runConvertAction({
      to: 'der',
      p12Password: 'pw',
      outDir: dir,
      output: 'text',
      force: false,
    })

    expect(process.exitCode).toBe(2)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Invalid --to value')
  })
})
