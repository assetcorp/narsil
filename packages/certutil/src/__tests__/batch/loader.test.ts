import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadClusterConfig } from '../../batch/loader'
import { ensureDirectory } from '../../output/writer'

function tempDir(): string {
  return join(tmpdir(), `certutil-loader-test-${randomBytes(8).toString('hex')}`)
}

describe('loadClusterConfig', () => {
  let dir: string

  beforeEach(async () => {
    dir = tempDir()
    await ensureDirectory(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loads a valid YAML cluster config', async () => {
    const yaml = `
nodes:
  - cn: narsil-node-01
    ip:
      - 10.0.0.1
    dns:
      - node01.narsil.local
  - cn: narsil-node-02
    ip:
      - 10.0.0.2
defaults:
  days: 730
  keySize: 4096
`
    const filePath = join(dir, 'cluster.yaml')
    await writeFile(filePath, yaml, 'utf-8')

    const config = await loadClusterConfig(filePath)
    expect(config.nodes).toHaveLength(2)
    expect(config.nodes[0].cn).toBe('narsil-node-01')
    expect(config.nodes[0].ip).toEqual(['10.0.0.1'])
    expect(config.nodes[0].dns).toEqual(['node01.narsil.local'])
    expect(config.nodes[1].cn).toBe('narsil-node-02')
    expect(config.defaults?.days).toBe(730)
    expect(config.defaults?.keySize).toBe(4096)
  })

  it('loads a valid JSON cluster config', async () => {
    const json = JSON.stringify({
      nodes: [{ cn: 'json-node-01', ip: ['192.168.1.1'], dns: ['node01.local'] }],
    })
    const filePath = join(dir, 'cluster.json')
    await writeFile(filePath, json, 'utf-8')

    const config = await loadClusterConfig(filePath)
    expect(config.nodes).toHaveLength(1)
    expect(config.nodes[0].cn).toBe('json-node-01')
  })

  it('loads a .yml file as YAML', async () => {
    const yaml = `
nodes:
  - cn: yml-node
`
    const filePath = join(dir, 'cluster.yml')
    await writeFile(filePath, yaml, 'utf-8')

    const config = await loadClusterConfig(filePath)
    expect(config.nodes[0].cn).toBe('yml-node')
  })

  it('falls back to YAML parsing for unknown extensions', async () => {
    const yaml = `
nodes:
  - cn: unknown-ext-node
`
    const filePath = join(dir, 'cluster.conf')
    await writeFile(filePath, yaml, 'utf-8')

    const config = await loadClusterConfig(filePath)
    expect(config.nodes[0].cn).toBe('unknown-ext-node')
  })

  it('rejects config with missing nodes array', async () => {
    const filePath = join(dir, 'bad.yaml')
    await writeFile(filePath, 'defaults:\n  days: 365\n', 'utf-8')

    await expect(loadClusterConfig(filePath)).rejects.toThrow("missing required 'nodes' array")
  })

  it('rejects config with empty nodes array', async () => {
    const filePath = join(dir, 'empty.yaml')
    await writeFile(filePath, 'nodes: []\n', 'utf-8')

    await expect(loadClusterConfig(filePath)).rejects.toThrow('at least one entry')
  })

  it('rejects node missing cn field', async () => {
    const yaml = `
nodes:
  - ip:
      - 10.0.0.1
`
    const filePath = join(dir, 'no-cn.yaml')
    await writeFile(filePath, yaml, 'utf-8')

    await expect(loadClusterConfig(filePath)).rejects.toThrow("index 0 is missing required 'cn'")
  })

  it('rejects node with non-string cn', async () => {
    const yaml = `
nodes:
  - cn: 123
`
    const filePath = join(dir, 'bad-cn.yaml')
    await writeFile(filePath, yaml, 'utf-8')

    await expect(loadClusterConfig(filePath)).rejects.toThrow("missing required 'cn'")
  })

  it('rejects node with ip that is not a string array', async () => {
    const yaml = `
nodes:
  - cn: test
    ip: 10.0.0.1
`
    const filePath = join(dir, 'bad-ip.yaml')
    await writeFile(filePath, yaml, 'utf-8')

    await expect(loadClusterConfig(filePath)).rejects.toThrow("invalid 'ip' field")
  })

  it('rejects node with dns that is not a string array', async () => {
    const yaml = `
nodes:
  - cn: test
    dns: node.local
`
    const filePath = join(dir, 'bad-dns.yaml')
    await writeFile(filePath, yaml, 'utf-8')

    await expect(loadClusterConfig(filePath)).rejects.toThrow("invalid 'dns' field")
  })

  it('validates defaults.days is a positive integer', async () => {
    const yaml = `
nodes:
  - cn: test
defaults:
  days: -5
`
    const filePath = join(dir, 'bad-days.yaml')
    await writeFile(filePath, yaml, 'utf-8')

    await expect(loadClusterConfig(filePath)).rejects.toThrow('positive integer')
  })

  it('validates defaults.keySize is 2048 or 4096', async () => {
    const yaml = `
nodes:
  - cn: test
defaults:
  keySize: 1024
`
    const filePath = join(dir, 'bad-keysize.yaml')
    await writeFile(filePath, yaml, 'utf-8')

    await expect(loadClusterConfig(filePath)).rejects.toThrow('2048 or 4096')
  })

  it('returns undefined defaults when not specified', async () => {
    const yaml = `
nodes:
  - cn: no-defaults
`
    const filePath = join(dir, 'no-defaults.yaml')
    await writeFile(filePath, yaml, 'utf-8')

    const config = await loadClusterConfig(filePath)
    expect(config.defaults).toBeUndefined()
  })

  it('allows nodes without ip and dns fields', async () => {
    const yaml = `
nodes:
  - cn: minimal-node
`
    const filePath = join(dir, 'minimal.yaml')
    await writeFile(filePath, yaml, 'utf-8')

    const config = await loadClusterConfig(filePath)
    expect(config.nodes[0].cn).toBe('minimal-node')
    expect(config.nodes[0].ip).toBeUndefined()
    expect(config.nodes[0].dns).toBeUndefined()
  })
})
