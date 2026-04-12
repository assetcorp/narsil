import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { runCertAction } from '../../commands/cert'
import { generateCaCertificate } from '../../crypto/ca'
import { ensureDirectory, fileExists } from '../../output/writer'

function tempDir(): string {
  return join(tmpdir(), `certutil-cert-cmd-test-${randomBytes(8).toString('hex')}`)
}

const ca = generateCaCertificate({ name: 'Test Cmd CA', days: 3650, keySize: 2048 })

describe('cert command', () => {
  let dir: string
  let originalExitCode: number | undefined
  let stderrChunks: string[]
  let stdoutChunks: string[]
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dir = tempDir()
    await ensureDirectory(dir)
    await writeFile(join(dir, 'ca.crt'), ca.certPem)
    await writeFile(join(dir, 'ca.key'), ca.keyPem)
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

  it('generates a node certificate signed by the CA', async () => {
    const outDir = join(dir, 'out')
    await runCertAction({
      cn: 'narsil-node-1',
      caCert: join(dir, 'ca.crt'),
      caKey: join(dir, 'ca.key'),
      ip: ['10.0.0.1'],
      dns: ['node1.cluster.local'],
      days: '365',
      keySize: '2048',
      outDir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    expect(await fileExists(join(outDir, 'narsil-node-1.crt'))).toBe(true)
    expect(await fileExists(join(outDir, 'narsil-node-1.key'))).toBe(true)

    const certContent = await readFile(join(outDir, 'narsil-node-1.crt'), 'utf-8')
    expect(certContent).toContain('BEGIN CERTIFICATE')

    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Created files:')
    expect(stderr).toContain('Fingerprint:')
  })

  it('outputs JSON envelope in json mode', async () => {
    const outDir = join(dir, 'out-json')
    await runCertAction({
      cn: 'json-node',
      caCert: join(dir, 'ca.crt'),
      caKey: join(dir, 'ca.key'),
      days: '365',
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
    expect(envelope.data.fingerprint).toBeTruthy()
  })

  it('runs batch mode with a cluster config YAML file', async () => {
    const outDir = join(dir, 'batch-out')
    const configPath = join(dir, 'cluster.yaml')

    const config = {
      nodes: [
        { cn: 'batch-node-01', ip: ['10.0.0.1'], dns: ['node01.local'] },
        { cn: 'batch-node-02', ip: ['10.0.0.2'] },
      ],
      defaults: { days: 365, keySize: 2048 },
    }
    await writeFile(configPath, yamlStringify(config))

    await runCertAction({
      caCert: join(dir, 'ca.crt'),
      caKey: join(dir, 'ca.key'),
      days: '365',
      keySize: '2048',
      outDir,
      output: 'text',
      force: false,
      dryRun: false,
      nodes: configPath,
    })

    expect(await fileExists(join(outDir, 'batch-node-01', 'batch-node-01.crt'))).toBe(true)
    expect(await fileExists(join(outDir, 'batch-node-01', 'batch-node-01.key'))).toBe(true)
    expect(await fileExists(join(outDir, 'batch-node-02', 'batch-node-02.crt'))).toBe(true)
    expect(await fileExists(join(outDir, 'batch-node-02', 'batch-node-02.key'))).toBe(true)
  })

  it('errors when neither --cn nor --nodes is provided', async () => {
    await runCertAction({
      caCert: join(dir, 'ca.crt'),
      caKey: join(dir, 'ca.key'),
      days: '365',
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

  it('errors when CA cert file does not exist', async () => {
    await runCertAction({
      cn: 'bad-node',
      caCert: join(dir, 'nonexistent-ca.crt'),
      caKey: join(dir, 'ca.key'),
      days: '365',
      keySize: '2048',
      outDir: dir,
      output: 'text',
      force: false,
      dryRun: false,
    })

    expect(process.exitCode).toBe(1)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('File not found')
  })

  it('does not write files in dry-run mode', async () => {
    const outDir = join(dir, 'dry-out')
    await runCertAction({
      cn: 'dry-node',
      caCert: join(dir, 'ca.crt'),
      caKey: join(dir, 'ca.key'),
      days: '365',
      keySize: '2048',
      outDir,
      output: 'text',
      force: false,
      dryRun: true,
    })

    expect(await fileExists(join(outDir, 'dry-node.crt'))).toBe(false)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Dry run')
  })

  it('does not write files in batch dry-run mode', async () => {
    const outDir = join(dir, 'batch-dry')
    const configPath = join(dir, 'cluster-dry.yaml')

    const config = {
      nodes: [{ cn: 'dry-batch-node' }],
    }
    await writeFile(configPath, yamlStringify(config))

    await runCertAction({
      caCert: join(dir, 'ca.crt'),
      caKey: join(dir, 'ca.key'),
      days: '365',
      keySize: '2048',
      outDir,
      output: 'text',
      force: false,
      dryRun: true,
      nodes: configPath,
    })

    expect(await fileExists(join(outDir, 'dry-batch-node', 'dry-batch-node.crt'))).toBe(false)
    const stderr = stderrChunks.join('')
    expect(stderr).toContain('Dry run')
    expect(stderr).toContain('Would create')
  })
})
