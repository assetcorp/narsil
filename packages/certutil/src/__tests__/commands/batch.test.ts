import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import {
  type Authority,
  createAuthority,
  createWorkspace,
  daysUntilExpiry,
  expectNoPrivateKeyInOutput,
  expectRefusal,
  listFiles,
  loadIdentity,
  modulusBits,
  removeWorkspace,
  runCli,
  subjectAlternativeNames,
} from '../support/cli'
import { parseCsr } from '../support/csr-der'

const THREE_NODES = {
  nodes: [
    { cn: 'node1', ip: ['10.0.0.1'], dns: ['node1.cluster.local'] },
    { cn: 'node2', ip: ['10.0.0.2'], dns: ['node2.cluster.local'] },
    { cn: 'node3', ip: ['10.0.0.3', '10.0.0.4'] },
  ],
}

const CERT_FILES = [
  'node1/node1.crt',
  'node1/node1.key',
  'node2/node2.crt',
  'node2/node2.key',
  'node3/node3.crt',
  'node3/node3.key',
]

describe('narsil-certutil batch mode', () => {
  let root: string
  let authority: Authority

  beforeAll(async () => {
    root = await createWorkspace()
    authority = await createAuthority(await createWorkspace(root), 'Batch Test CA')
  })

  afterAll(async () => {
    await removeWorkspace(root)
  })

  function batchCertArgs(configPath: string, outDir: string): string[] {
    return [
      'cert',
      '--ca-cert',
      authority.certPath,
      '--ca-key',
      authority.keyPath,
      '--nodes',
      configPath,
      '--out-dir',
      outDir,
    ]
  }

  async function writeConfig(name: string, content: string): Promise<string> {
    const path = join(await createWorkspace(root), name)
    await writeFile(path, content)
    return path
  }

  it('issues each node in a YAML file a chained certificate with its own key and only its own names', async () => {
    const outDir = await createWorkspace(root)
    const configPath = await writeConfig('cluster.yaml', stringifyYaml(THREE_NODES))

    const result = await runCli(batchCertArgs(configPath, outDir))

    expect(result.code).toBe(0)
    expectNoPrivateKeyInOutput(result)
    expect(await listFiles(outDir)).toEqual(CERT_FILES)
    const node1 = await loadIdentity(join(outDir, 'node1/node1.crt'), join(outDir, 'node1/node1.key'))
    const node2 = await loadIdentity(join(outDir, 'node2/node2.crt'), join(outDir, 'node2/node2.key'))
    const node3 = await loadIdentity(join(outDir, 'node3/node3.crt'), join(outDir, 'node3/node3.key'))
    for (const node of [node1, node2, node3]) {
      expect(node.certificate.verify(authority.certificate.publicKey)).toBe(true)
      expect(node.certificate.checkPrivateKey(node.privateKey)).toBe(true)
    }
    expect(node1.certificate.checkPrivateKey(node2.privateKey)).toBe(false)
    expect(subjectAlternativeNames(node1.certificate)).toEqual(['DNS:node1.cluster.local', 'IP Address:10.0.0.1'])
    expect(subjectAlternativeNames(node2.certificate)).toEqual(['DNS:node2.cluster.local', 'IP Address:10.0.0.2'])
    expect(subjectAlternativeNames(node3.certificate)).toEqual(['IP Address:10.0.0.3', 'IP Address:10.0.0.4'])
    expect(new Set([node1, node2, node3].map(node => node.certificate.serialNumber)).size).toBe(3)
  })

  it('reads a JSON file and applies its defaults to validity and key size', async () => {
    const outDir = await createWorkspace(root)
    const configPath = await writeConfig(
      'cluster.json',
      JSON.stringify({ nodes: [{ cn: 'json-node' }], defaults: { days: 45, keySize: 2048 } }),
    )

    const result = await runCli([...batchCertArgs(configPath, outDir), '--key-size', '4096'])

    expect(result.code).toBe(0)
    const node = await loadIdentity(join(outDir, 'json-node/json-node.crt'), join(outDir, 'json-node/json-node.key'))
    expect(daysUntilExpiry(node.certificate)).toBe(45)
    expect(modulusBits(node.privateKey)).toBe(2048)
  })

  it('writes one signed CSR and key per node', async () => {
    const outDir = await createWorkspace(root)
    const configPath = await writeConfig('cluster.yml', stringifyYaml(THREE_NODES))

    const result = await runCli(['csr', '--nodes', configPath, '--out-dir', outDir])

    expect(result.code).toBe(0)
    expect(await listFiles(outDir)).toEqual(CERT_FILES.map(file => file.replace('.crt', '.csr')))
    const node2 = parseCsr(await readFile(join(outDir, 'node2/node2.csr'), 'utf-8'))
    expect(node2.signatureValid).toBe(true)
    expect(node2.commonName).toBe('node2')
    expect(node2.ipAddresses).toEqual(['10.0.0.2'])
    expect(node2.dnsNames).toEqual(['node2.cluster.local'])
  })

  it('writes nothing in a dry run for certificates or CSRs', async () => {
    const outDir = join(await createWorkspace(root), 'never-created')
    const configPath = await writeConfig('cluster.yaml', stringifyYaml(THREE_NODES))

    const certs = await runCli([...batchCertArgs(configPath, outDir), '--dry-run'])
    const csrs = await runCli(['csr', '--nodes', configPath, '--out-dir', outDir, '--dry-run'])

    expect(certs.code).toBe(0)
    expect(certs.stderr).toContain(join(outDir, 'node3', 'node3.key'))
    expect(csrs.code).toBe(0)
    expect(csrs.stderr).toContain(join(outDir, 'node3', 'node3.csr'))
    expect(await listFiles(outDir)).toEqual([])
  })

  it('leaves existing node files untouched without --force and replaces them with --force', async () => {
    const outDir = await createWorkspace(root)
    const configPath = await writeConfig('cluster.yaml', stringifyYaml(THREE_NODES))
    const args = batchCertArgs(configPath, outDir)
    expect((await runCli(args)).code).toBe(0)
    const keyPath = join(outDir, 'node1/node1.key')
    const originalKey = await readFile(keyPath, 'utf-8')

    const refused = await runCli(args)

    expectRefusal(refused, 1, /File already exists.*--force/)
    expect(await readFile(keyPath, 'utf-8')).toBe(originalKey)

    const forced = await runCli([...args, '--force'])

    expect(forced.code).toBe(0)
    expect(await readFile(keyPath, 'utf-8')).not.toBe(originalKey)
  })

  it.each([
    ['a YAML scalar', 'cluster.yaml', 'plain text', /must be an object/],
    ['YAML that does not parse', 'cluster.yaml', ': [', /./],
    ['JSON that does not parse', 'cluster.json', '{ "nodes": [', /JSON/],
    ['an empty file', 'cluster.yaml', '', /must be an object/],
    ['a missing nodes array', 'cluster.yaml', 'defaults: { days: 30 }', /'nodes' array/],
    ['an empty nodes array', 'cluster.yaml', 'nodes: []', /at least one entry/],
    ['a node that is not an object', 'cluster.yaml', 'nodes: [node1]', /must be an object/],
    ['a node without a common name', 'cluster.yaml', 'nodes: [{ ip: [10.0.0.1] }]', /'cn'/],
    ['an ip field that is not a list', 'cluster.yaml', 'nodes: [{ cn: a, ip: 10.0.0.1 }]', /'ip'/],
    ['a dns field that is not a list', 'cluster.yaml', 'nodes: [{ cn: a, dns: a.local }]', /'dns'/],
    ['a negative default validity', 'cluster.yaml', 'nodes: [{ cn: a }]\ndefaults: { days: -1 }', /defaults.days/],
    ['a bad default key size', 'cluster.yaml', 'nodes: [{ cn: a }]\ndefaults: { keySize: 1024 }', /defaults.keySize/],
  ])('refuses %s and writes nothing', async (_label, fileName, content, message) => {
    const outDir = await createWorkspace(root)
    const configPath = await writeConfig(fileName, content)

    const certs = await runCli(batchCertArgs(configPath, outDir))
    const csrs = await runCli(['csr', '--nodes', configPath, '--out-dir', outDir])

    expectRefusal(certs, 1, message)
    expectRefusal(csrs, 1, message)
    expect(await listFiles(outDir)).toEqual([])
  })

  it('refuses a cluster file that does not exist', async () => {
    const outDir = await createWorkspace(root)

    const result = await runCli(batchCertArgs(join(outDir, 'absent.yaml'), outDir))

    expectRefusal(result, 1, /ENOENT/)
  })
})
