import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBatchCert, runBatchCsr } from '../../batch/runner'
import { generateCaCertificate } from '../../crypto/ca'
import { ensureDirectory, fileExists } from '../../output/writer'
import type { ClusterConfig } from '../../types'

function tempDir(): string {
  return join(tmpdir(), `certutil-runner-test-${randomBytes(8).toString('hex')}`)
}

const ca = generateCaCertificate({ name: 'Test Batch CA', days: 3650, keySize: 2048 })

const twoNodeConfig: ClusterConfig = {
  nodes: [
    { cn: 'narsil-node-01', ip: ['10.0.0.1'], dns: ['node01.cluster.local'] },
    { cn: 'narsil-node-02', ip: ['10.0.0.2'], dns: ['node02.cluster.local'] },
  ],
  defaults: { days: 365, keySize: 2048 },
}

describe('runBatchCert', () => {
  let dir: string

  beforeEach(async () => {
    dir = tempDir()
    await ensureDirectory(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('generates certs for all nodes in config', async () => {
    const results = await runBatchCert(twoNodeConfig, ca.certPem, ca.keyPem, dir, false, 365, 2048)

    expect(results).toHaveLength(2)
    expect(results[0].cn).toBe('narsil-node-01')
    expect(results[1].cn).toBe('narsil-node-02')
    expect(results[0].fingerprint).toBeTruthy()
    expect(results[1].fingerprint).toBeTruthy()
    expect(results[0].certPem).toContain('BEGIN CERTIFICATE')
    expect(results[0].keyPem).toContain('BEGIN RSA PRIVATE KEY')
  })

  it('writes cert and key files to correct directories', async () => {
    await runBatchCert(twoNodeConfig, ca.certPem, ca.keyPem, dir, false, 365, 2048)

    const certPath1 = join(dir, 'narsil-node-01', 'narsil-node-01.crt')
    const keyPath1 = join(dir, 'narsil-node-01', 'narsil-node-01.key')
    const certPath2 = join(dir, 'narsil-node-02', 'narsil-node-02.crt')
    const keyPath2 = join(dir, 'narsil-node-02', 'narsil-node-02.key')

    expect(await fileExists(certPath1)).toBe(true)
    expect(await fileExists(keyPath1)).toBe(true)
    expect(await fileExists(certPath2)).toBe(true)
    expect(await fileExists(keyPath2)).toBe(true)

    const certContent = await readFile(certPath1, 'utf-8')
    expect(certContent).toContain('BEGIN CERTIFICATE')
  })

  it('throws when files exist and overwrite is false', async () => {
    await runBatchCert(twoNodeConfig, ca.certPem, ca.keyPem, dir, false, 365, 2048)

    await expect(runBatchCert(twoNodeConfig, ca.certPem, ca.keyPem, dir, false, 365, 2048)).rejects.toThrow(
      'File already exists',
    )
  })

  it('succeeds with overwrite when files exist', async () => {
    await runBatchCert(twoNodeConfig, ca.certPem, ca.keyPem, dir, false, 365, 2048)
    const results = await runBatchCert(twoNodeConfig, ca.certPem, ca.keyPem, dir, true, 365, 2048)
    expect(results).toHaveLength(2)
  })

  it('uses config defaults over function params', async () => {
    const configWithDefaults: ClusterConfig = {
      nodes: [{ cn: 'default-test-node' }],
      defaults: { keySize: 2048 },
    }

    const results = await runBatchCert(configWithDefaults, ca.certPem, ca.keyPem, dir, false, 365, 4096)
    expect(results).toHaveLength(1)
    expect(results[0].cn).toBe('default-test-node')
  })

  it('handles nodes without ip and dns', async () => {
    const minimalConfig: ClusterConfig = {
      nodes: [{ cn: 'bare-node' }],
    }

    const results = await runBatchCert(minimalConfig, ca.certPem, ca.keyPem, dir, false, 365, 2048)
    expect(results).toHaveLength(1)
    expect(results[0].cn).toBe('bare-node')
    expect(results[0].certPem).toContain('BEGIN CERTIFICATE')
  })
})

describe('runBatchCsr', () => {
  let dir: string

  beforeEach(async () => {
    dir = tempDir()
    await ensureDirectory(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('generates CSRs for all nodes in config', async () => {
    const results = await runBatchCsr(twoNodeConfig, dir, false, 2048)

    expect(results).toHaveLength(2)
    expect(results[0].cn).toBe('narsil-node-01')
    expect(results[1].cn).toBe('narsil-node-02')
    expect(results[0].csrPem).toContain('BEGIN CERTIFICATE REQUEST')
    expect(results[0].keyPem).toContain('BEGIN RSA PRIVATE KEY')
  })

  it('writes CSR and key files to correct directories', async () => {
    await runBatchCsr(twoNodeConfig, dir, false, 2048)

    const csrPath = join(dir, 'narsil-node-01', 'narsil-node-01.csr')
    const keyPath = join(dir, 'narsil-node-01', 'narsil-node-01.key')

    expect(await fileExists(csrPath)).toBe(true)
    expect(await fileExists(keyPath)).toBe(true)
  })

  it('throws when files exist and overwrite is false', async () => {
    await runBatchCsr(twoNodeConfig, dir, false, 2048)

    await expect(runBatchCsr(twoNodeConfig, dir, false, 2048)).rejects.toThrow('File already exists')
  })

  it('succeeds with overwrite when files exist', async () => {
    await runBatchCsr(twoNodeConfig, dir, false, 2048)
    const results = await runBatchCsr(twoNodeConfig, dir, true, 2048)
    expect(results).toHaveLength(2)
  })
})
