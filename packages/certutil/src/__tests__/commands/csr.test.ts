import { createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createWorkspace,
  expectNoPrivateKeyInOutput,
  expectRefusal,
  listFiles,
  modulusBits,
  parseEnvelope,
  removeWorkspace,
  runCli,
} from '../support/cli'
import { parseCsr } from '../support/csr-der'

describe('narsil-certutil csr', () => {
  let root: string

  beforeAll(async () => {
    root = await createWorkspace()
  })

  afterAll(async () => {
    await removeWorkspace(root)
  })

  it('writes a CSR signed by the matching private key that carries the requested names', async () => {
    const outDir = await createWorkspace(root)

    const result = await runCli([
      'csr',
      '--cn',
      'node1',
      '--ip',
      '10.0.0.1',
      '--dns',
      'node1.cluster.local',
      '--out-dir',
      outDir,
    ])

    expect(result.code).toBe(0)
    expectNoPrivateKeyInOutput(result)
    const csr = parseCsr(await readFile(join(outDir, 'node1.csr'), 'utf-8'))
    const privateKey = await readFile(join(outDir, 'node1.key'), 'utf-8')
    const derivedPublicKey = createPublicKey(privateKey)
    expect(csr.signatureValid).toBe(true)
    expect(csr.commonName).toBe('node1')
    expect(csr.ipAddresses).toEqual(['10.0.0.1'])
    expect(csr.dnsNames).toEqual(['node1.cluster.local'])
    expect(csr.publicKey.equals(derivedPublicKey)).toBe(true)
    expect(modulusBits(csr.publicKey)).toBe(2048)
  })

  it('generates a 4096-bit key when asked and reports both files in a parsable JSON envelope', async () => {
    const outDir = await createWorkspace(root)

    const result = await runCli(['csr', '--cn', 'big', '--key-size', '4096', '--out-dir', outDir, '--output', 'json'])

    expect(result.code).toBe(0)
    expectNoPrivateKeyInOutput(result)
    const envelope = parseEnvelope<{ files: Array<{ path: string; type: string }> }>(result.stdout)
    expect(envelope.data?.files).toEqual([
      { path: join(outDir, 'big.csr'), type: 'csr' },
      { path: join(outDir, 'big.key'), type: 'key' },
    ])
    expect(modulusBits(parseCsr(await readFile(join(outDir, 'big.csr'), 'utf-8')).publicKey)).toBe(4096)
  })

  it('leaves an existing CSR and key untouched without --force and replaces them with --force', async () => {
    const outDir = await createWorkspace(root)
    const args = ['csr', '--cn', 'node1', '--out-dir', outDir]
    expect((await runCli(args)).code).toBe(0)
    const originalCsr = await readFile(join(outDir, 'node1.csr'), 'utf-8')
    const originalKey = await readFile(join(outDir, 'node1.key'), 'utf-8')

    const refused = await runCli(args)

    expectRefusal(refused, 1, /File already exists.*--force/)
    expect(await readFile(join(outDir, 'node1.csr'), 'utf-8')).toBe(originalCsr)
    expect(await readFile(join(outDir, 'node1.key'), 'utf-8')).toBe(originalKey)

    const forced = await runCli([...args, '--force'])

    expect(forced.code).toBe(0)
    const replacement = parseCsr(await readFile(join(outDir, 'node1.csr'), 'utf-8'))
    expect(replacement.publicKey.equals(createPublicKey(originalKey))).toBe(false)
    expect(replacement.publicKey.equals(createPublicKey(await readFile(join(outDir, 'node1.key'))))).toBe(true)
  })

  it('writes nothing in a dry run', async () => {
    const outDir = join(await createWorkspace(root), 'never-created')

    const result = await runCli(['csr', '--cn', 'dry', '--out-dir', outDir, '--dry-run'])

    expect(result.code).toBe(0)
    expect(await listFiles(outDir)).toEqual([])
  })

  it.each([
    [['--cn', 'node1', '--key-size', '1024'], 2, /Invalid --key-size/],
    [[], 2, /--cn or --nodes/],
    [['--cn', 'node1', '--ip', 'not-an-ip'], 1, /not a valid IPv4 or IPv6/],
  ])('refuses the arguments %j and writes nothing', async (args, code, message) => {
    const outDir = await createWorkspace(root)

    const result = await runCli(['csr', '--out-dir', outDir, ...args])

    expectRefusal(result, code, message)
    expect(await listFiles(outDir)).toEqual([])
  })
})
