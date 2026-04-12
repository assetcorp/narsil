import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCaAction } from '../../commands/ca'
import { fileExists } from '../../output/writer'

function tempDir(): string {
  return join(tmpdir(), `certutil-ca-cmd-test-${randomBytes(8).toString('hex')}`)
}

describe('ca command', () => {
  let dir: string
  let originalExitCode: number | undefined
  let stderrChunks: string[]
  let stdoutChunks: string[]
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = tempDir()
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

  it('generates CA cert and key files in the output directory', async () => {
    await runCaAction({
      name: 'Test CA',
      days: '365',
      keySize: '2048',
      outDir: dir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    expect(await fileExists(join(dir, 'ca.crt'))).toBe(true)
    expect(await fileExists(join(dir, 'ca.key'))).toBe(true)

    const certContent = await readFile(join(dir, 'ca.crt'), 'utf-8')
    expect(certContent).toContain('BEGIN CERTIFICATE')

    const keyContent = await readFile(join(dir, 'ca.key'), 'utf-8')
    expect(keyContent).toContain('BEGIN RSA PRIVATE KEY')
  })

  it('outputs generation info to stderr in text mode', async () => {
    await runCaAction({
      name: 'Test CA',
      days: '365',
      keySize: '2048',
      outDir: dir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Created files:')
    expect(stderr).toContain('ca.crt')
    expect(stderr).toContain('ca.key')
    expect(stderr).toContain('Fingerprint:')
  })

  it('outputs JSON envelope to stdout in json mode', async () => {
    await runCaAction({
      name: 'Test CA',
      days: '365',
      keySize: '2048',
      outDir: dir,
      output: 'json',
      force: false,
      dryRun: false,
    })

    const stdout = stdoutChunks.join('')
    const envelope = JSON.parse(stdout)
    expect(envelope.status).toBe('success')
    expect(envelope.data.files).toHaveLength(2)
    expect(envelope.data.fingerprint).toBeTruthy()
    expect(envelope.data.expiresAt).toBeTruthy()
    expect(envelope.metadata.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('does not write files in dry-run mode', async () => {
    await runCaAction({
      name: 'Dry Run CA',
      days: '3650',
      keySize: '2048',
      outDir: dir,
      output: 'text',
      force: false,
      dryRun: true,
    })

    expect(await fileExists(join(dir, 'ca.crt'))).toBe(false)
    expect(await fileExists(join(dir, 'ca.key'))).toBe(false)

    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Dry run')
    expect(stderr).toContain('Would create')
  })

  it('rejects invalid --days value and sets BAD_ARGUMENTS exit code', async () => {
    await runCaAction({
      name: 'Bad CA',
      days: 'abc',
      keySize: '2048',
      outDir: dir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    expect(process.exitCode).toBe(2)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Invalid --days')
  })

  it('rejects invalid --key-size value', async () => {
    await runCaAction({
      name: 'Bad CA',
      days: '365',
      keySize: '1024',
      outDir: dir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    expect(process.exitCode).toBe(2)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Invalid --key-size')
  })

  it('fails when files exist and --force is false', async () => {
    await runCaAction({
      name: 'First CA',
      days: '365',
      keySize: '2048',
      outDir: dir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    stderrChunks = []
    await runCaAction({
      name: 'Second CA',
      days: '365',
      keySize: '2048',
      outDir: dir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    expect(process.exitCode).toBe(1)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('File already exists')
  })

  it('overwrites files when --force is true', async () => {
    await runCaAction({
      name: 'First CA',
      days: '365',
      keySize: '2048',
      outDir: dir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    await runCaAction({
      name: 'Second CA',
      days: '365',
      keySize: '2048',
      outDir: dir,
      output: 'text',
      force: true,
      dryRun: false,
    })

    const certContent = await readFile(join(dir, 'ca.crt'), 'utf-8')
    expect(certContent).toContain('BEGIN CERTIFICATE')
  })
})
