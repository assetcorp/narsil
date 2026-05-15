import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { runCsrAction } from '../../commands/csr'
import { ensureDirectory, fileExists } from '../../output/writer'

function tempDir(): string {
  return join(tmpdir(), `certutil-csr-cmd-test-${randomBytes(8).toString('hex')}`)
}

describe('csr command', () => {
  let dir: string
  let originalExitCode: string | number | null | undefined
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

  it('generates CSR and key files', async () => {
    const outDir = join(dir, 'out')
    await runCsrAction({
      cn: 'csr-node-1',
      ip: ['192.168.1.1'],
      dns: ['csr-node.local'],
      keySize: '2048',
      outDir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    expect(await fileExists(join(outDir, 'csr-node-1.csr'))).toBe(true)
    expect(await fileExists(join(outDir, 'csr-node-1.key'))).toBe(true)

    const csrContent = await readFile(join(outDir, 'csr-node-1.csr'), 'utf-8')
    expect(csrContent).toContain('BEGIN CERTIFICATE REQUEST')

    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Created files:')
  })

  it('outputs JSON in json mode', async () => {
    const outDir = join(dir, 'json-out')
    await runCsrAction({
      cn: 'json-csr-node',
      keySize: '2048',
      outDir,
      output: 'json',
      force: false,
      dryRun: false,
    })

    const stdout = stdoutChunks.join('')
    const envelope = JSON.parse(stdout)
    expect(envelope.status).toBe('success')
    expect(envelope.data.files).toHaveLength(2)
    expect(envelope.data.files[0].type).toBe('csr')
  })

  it('runs batch mode with a cluster config', async () => {
    const outDir = join(dir, 'batch-out')
    const configPath = join(dir, 'csr-cluster.yaml')

    const config = {
      nodes: [
        { cn: 'batch-csr-01', ip: ['10.0.0.1'] },
        { cn: 'batch-csr-02', dns: ['node02.local'] },
      ],
    }
    await writeFile(configPath, yamlStringify(config))

    await runCsrAction({
      keySize: '2048',
      outDir,
      output: 'text',
      force: false,
      dryRun: false,
      nodes: configPath,
    })

    expect(await fileExists(join(outDir, 'batch-csr-01', 'batch-csr-01.csr'))).toBe(true)
    expect(await fileExists(join(outDir, 'batch-csr-01', 'batch-csr-01.key'))).toBe(true)
    expect(await fileExists(join(outDir, 'batch-csr-02', 'batch-csr-02.csr'))).toBe(true)
    expect(await fileExists(join(outDir, 'batch-csr-02', 'batch-csr-02.key'))).toBe(true)
  })

  it('errors when neither --cn nor --nodes is provided', async () => {
    await runCsrAction({
      keySize: '2048',
      outDir: dir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    expect(process.exitCode).toBe(2)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Provide either --cn or --nodes')
  })

  it('does not write files in dry-run mode', async () => {
    const outDir = join(dir, 'dry')
    await runCsrAction({
      cn: 'dry-csr',
      keySize: '2048',
      outDir,
      output: 'text',
      force: false,
      dryRun: true,
    })

    expect(await fileExists(join(outDir, 'dry-csr.csr'))).toBe(false)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Dry run')
    expect(stderr).toContain('Would create')
  })

  it('rejects invalid key size', async () => {
    await runCsrAction({
      cn: 'bad-csr',
      keySize: '512',
      outDir: dir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    expect(process.exitCode).toBe(2)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Invalid --key-size')
  })

  it('does not write files in batch dry-run mode', async () => {
    const outDir = join(dir, 'batch-dry')
    const configPath = join(dir, 'batch-dry-cluster.yaml')

    const config = { nodes: [{ cn: 'dry-batch-csr' }] }
    await writeFile(configPath, yamlStringify(config))

    await runCsrAction({
      keySize: '2048',
      outDir,
      output: 'text',
      force: false,
      dryRun: true,
      nodes: configPath,
    })

    expect(await fileExists(join(outDir, 'dry-batch-csr', 'dry-batch-csr.csr'))).toBe(false)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Dry run')
  })
})
