import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInspectAction } from '../../commands/inspect'
import { runVerifyAction } from '../../commands/verify'
import { generateCaCertificate } from '../../crypto/ca'
import { generateNodeCertificate } from '../../crypto/certificate'
import { detectPemType, pemToCertificate, pemToCsr, pemToPrivateKey } from '../../crypto/pem'
import { ensureDirectory } from '../../output/writer'

describe('detectPemType with invalid input', () => {
  it('returns unknown for binary garbage', () => {
    const garbage = Buffer.from([0x00, 0x01, 0xff, 0xfe]).toString()
    expect(detectPemType(garbage)).toBe('unknown')
  })

  it('returns unknown for an empty string', () => {
    expect(detectPemType('')).toBe('unknown')
  })
})

describe('PEM parsing with corrupted data', () => {
  it('throws when pemToCertificate receives a valid header with garbage body', () => {
    const corrupted = '-----BEGIN CERTIFICATE-----\nNOTVALIDBASE64\n-----END CERTIFICATE-----'
    expect(() => pemToCertificate(corrupted)).toThrow()
  })

  it('throws when pemToCertificate receives a truncated PEM', () => {
    const ca = generateCaCertificate({ name: 'Truncate CA', days: 365, keySize: 2048 })
    const node = generateNodeCertificate({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      cn: 'truncate-node',
      ipSans: [],
      dnsSans: [],
      days: 365,
      keySize: 2048,
    })
    const halfLength = Math.floor(node.certPem.length / 2)
    const truncated = node.certPem.slice(0, halfLength)
    expect(() => pemToCertificate(truncated)).toThrow()
  })

  it('throws when pemToPrivateKey receives a valid header with garbage body', () => {
    const corrupted = '-----BEGIN RSA PRIVATE KEY-----\nGARBAGE\n-----END RSA PRIVATE KEY-----'
    expect(() => pemToPrivateKey(corrupted)).toThrow()
  })

  it('throws when pemToCsr receives a valid header with garbage body', () => {
    const corrupted = '-----BEGIN CERTIFICATE REQUEST-----\nGARBAGE\n-----END CERTIFICATE REQUEST-----'
    expect(() => pemToCsr(corrupted)).toThrow()
  })

  it('throws when pemToPrivateKey receives an empty string', () => {
    expect(() => pemToPrivateKey('')).toThrow()
  })
})

describe('commands with corrupted PEM files', () => {
  let dir: string
  let originalExitCode: string | number | null | undefined
  let stdoutChunks: string[]
  let stderrChunks: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dir = join(tmpdir(), `certutil-malformed-${randomBytes(8).toString('hex')}`)
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

  it('inspect command sets exitCode to 1 and writes to stderr for a corrupted cert', async () => {
    const corruptedPem = '-----BEGIN CERTIFICATE-----\nDEFINITELYNOTVALID\n-----END CERTIFICATE-----'
    const filePath = join(dir, 'corrupted.crt')
    await writeFile(filePath, corruptedPem)

    await runInspectAction(filePath, { output: 'text' })

    expect(process.exitCode).toBe(1)
    const stderr = stderrChunks.join('')
    expect(stderr.length).toBeGreaterThan(0)
  })

  it('verify command sets exitCode to 1 and writes to stderr for a corrupted cert', async () => {
    const corruptedPem = '-----BEGIN CERTIFICATE-----\nDEFINITELYNOTVALID\n-----END CERTIFICATE-----'
    const filePath = join(dir, 'corrupted.crt')
    await writeFile(filePath, corruptedPem)

    await runVerifyAction({ cert: filePath, output: 'text' })

    expect(process.exitCode).toBe(1)
    const stderr = stderrChunks.join('')
    expect(stderr.length).toBeGreaterThan(0)
  })
})
