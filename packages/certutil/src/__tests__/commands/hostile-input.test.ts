import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Authority,
  createAuthority,
  createWorkspace,
  expectRefusal,
  issueNodeCertificate,
  listFiles,
  type NodeIdentity,
  parseEnvelope,
  removeWorkspace,
  runCli,
} from '../support/cli'

const OWNER_ONLY = 0o600
const GROUP_AND_OTHER_BITS = 0o077
const BAD_ARGUMENTS_EXIT_CODE = 2
const SERIALS_TO_SAMPLE = 8

describe.skipIf(process.platform === 'win32')('private files', () => {
  let root: string
  let authority: Authority
  let node: NodeIdentity

  beforeAll(async () => {
    root = await createWorkspace()
    authority = await createAuthority(await createWorkspace(root), 'Files Test CA')
    node = await issueNodeCertificate(authority, await createWorkspace(root), 'node1')
  })

  afterAll(async () => {
    await removeWorkspace(root)
  })

  async function expectOwnerOnly(path: string): Promise<void> {
    expect((await stat(path)).mode & 0o777, path).toBe(OWNER_ONLY)
  }

  it('keeps every private key and PKCS#12 file away from other accounts', async () => {
    await expectOwnerOnly(authority.keyPath)
    await expectOwnerOnly(node.keyPath)

    const csrDirectory = await createWorkspace(root)
    await runCli(['csr', '--cn', 'node2', '--out-dir', csrDirectory])
    await expectOwnerOnly(join(csrDirectory, 'node2.key'))

    const p12Directory = await createWorkspace(root)
    const pack = ['convert', '--cert', node.certPath, '--key', node.keyPath, '--to', 'p12', '--p12-password', 'pw']
    expect((await runCli([...pack, '--out-dir', p12Directory])).code).toBe(0)
    await expectOwnerOnly(join(p12Directory, 'certificate.p12'))

    const pemDirectory = await createWorkspace(root)
    const unpack = ['convert', '--p12', join(p12Directory, 'certificate.p12'), '--to', 'pem', '--p12-password', 'pw']
    expect((await runCli([...unpack, '--out-dir', pemDirectory])).code).toBe(0)
    await expectOwnerOnly(join(pemDirectory, 'key.pem'))
  })

  it('takes away access that an overwritten key file gave to other accounts', async () => {
    const directory = await createWorkspace(root)
    const keyPath = join(directory, 'node3.key')
    await writeFile(keyPath, 'old key', { mode: 0o644 })
    const issued = await runCli([
      'cert',
      '--cn',
      'node3',
      '--ca-cert',
      authority.certPath,
      '--ca-key',
      authority.keyPath,
      '--out-dir',
      directory,
      '--force',
    ])
    expect(issued.code).toBe(0)
    expect((await stat(keyPath)).mode & GROUP_AND_OTHER_BITS).toBe(0)
  })
})

describe('input that tries to do harm', () => {
  let root: string
  let authority: Authority
  let otherAuthority: Authority

  beforeAll(async () => {
    root = await createWorkspace()
    authority = await createAuthority(await createWorkspace(root), 'Hostile Test CA')
    otherAuthority = await createAuthority(await createWorkspace(root), 'Other Test CA')
  })

  afterAll(async () => {
    await removeWorkspace(root)
  })

  function issueWith(outDir: string, ...extra: string[]): Promise<Awaited<ReturnType<typeof runCli>>> {
    return runCli([
      'cert',
      '--ca-cert',
      authority.certPath,
      '--ca-key',
      authority.keyPath,
      '--out-dir',
      outDir,
      ...extra,
    ])
  }

  it.each(['../../escaped', '..', '.', 'a/b', 'a\\b'])('refuses the name %s and writes no file', async cn => {
    const outer = await createWorkspace(root)
    const outDir = join(outer, 'one', 'two')

    expectRefusal(await issueWith(outDir, '--cn', cn), BAD_ARGUMENTS_EXIT_CODE, /Invalid --cn value/)
    expectRefusal(await runCli(['csr', '--cn', cn, '--out-dir', outDir]), BAD_ARGUMENTS_EXIT_CODE, /Invalid --cn value/)

    const config = join(outer, 'cluster.json')
    await writeFile(config, JSON.stringify({ nodes: [{ cn }] }))
    expectRefusal(await issueWith(outDir, '--nodes', config), 1, /cannot name its output files/)
    expectRefusal(await runCli(['csr', '--nodes', config, '--out-dir', outDir]), 1, /cannot name its output files/)

    expect(await listFiles(outer)).toEqual(['cluster.json'])
  })

  it('refuses an address that is not an IP address, and writes no file', async () => {
    const outDir = await createWorkspace(root)
    expectRefusal(await issueWith(outDir, '--cn', 'node1', '--ip', '999.0.0.1'), 1, /Invalid IP address/)
    expectRefusal(
      await runCli(['csr', '--cn', 'node1', '--ip', '999.0.0.1', '--out-dir', outDir]),
      1,
      /Invalid IP address/,
    )
    expect(await listFiles(outDir)).toEqual([])
  })

  it('refuses a CA key that belongs to another CA, and a certificate that is no CA', async () => {
    const outDir = await createWorkspace(root)
    const mismatched = await runCli([
      'cert',
      '--cn',
      'node1',
      '--ca-cert',
      authority.certPath,
      '--ca-key',
      otherAuthority.keyPath,
      '--out-dir',
      outDir,
    ])
    expectRefusal(mismatched, 1, /does not belong/)

    const leaf = await issueNodeCertificate(authority, await createWorkspace(root), 'leaf')
    const underLeaf = await runCli([
      'cert',
      '--cn',
      'node1',
      '--ca-cert',
      leaf.certPath,
      '--ca-key',
      leaf.keyPath,
      '--out-dir',
      outDir,
    ])
    expectRefusal(underLeaf, 1, /not a certificate authority/)
    expect(await listFiles(outDir)).toEqual([])
  })

  it('fails verification of a chain whose issuer is no CA', async () => {
    const directory = await createWorkspace(root)
    const leaf = await issueNodeCertificate(authority, directory, 'leaf')
    const verified = await runCli(['verify', '--cert', leaf.certPath, '--ca-cert', leaf.certPath])
    expect(verified.code).toBe(1)
  })

  it('refuses to pack a key with a certificate it does not belong to', async () => {
    const directory = await createWorkspace(root)
    const first = await issueNodeCertificate(authority, directory, 'first')
    const second = await issueNodeCertificate(authority, directory, 'second')
    const outDir = await createWorkspace(root)
    const packed = await runCli([
      'convert',
      '--cert',
      first.certPath,
      '--key',
      second.keyPath,
      '--to',
      'p12',
      '--p12-password',
      'pw',
      '--out-dir',
      outDir,
    ])
    expectRefusal(packed, 1, /does not belong/)
    expect(await listFiles(outDir)).toEqual([])
  })

  it('prints one error and the argument exit code when convert lacks an input', async () => {
    const missing = await runCli(['convert', '--to', 'p12', '--p12-password', 'pw'])
    expect(missing.code).toBe(BAD_ARGUMENTS_EXIT_CODE)
    expect(missing.stderr.match(/Error:/g)).toHaveLength(1)
  })

  it('gives every certificate a positive serial number', async () => {
    const directory = await createWorkspace(root)
    for (let sample = 0; sample < SERIALS_TO_SAMPLE; sample++) {
      const { certificate } = await issueNodeCertificate(authority, directory, `node${sample}`)
      expect(Number.parseInt(certificate.serialNumber.slice(0, 2), 16), certificate.serialNumber).toBeLessThan(0x80)
    }
    expect(Number.parseInt(authority.certificate.serialNumber.slice(0, 2), 16)).toBeLessThan(0x80)
  })

  it('prints batch JSON as one document that lists every node', async () => {
    const outer = await createWorkspace(root)
    const config = join(outer, 'cluster.json')
    await writeFile(config, JSON.stringify({ nodes: [{ cn: 'node1' }, { cn: 'node2' }] }))

    const issued = await issueWith(join(outer, 'certs'), '--nodes', config, '--output', 'json')
    expect(issued.code).toBe(0)
    const envelope = parseEnvelope<Array<{ files: Array<{ path: string }> }>>(issued.stdout)
    expect(envelope.data?.map(entry => entry.files.length)).toEqual([2, 2])

    const requested = await runCli(['csr', '--nodes', config, '--out-dir', join(outer, 'csrs'), '--output', 'json'])
    expect(requested.code).toBe(0)
    expect(parseEnvelope<unknown[]>(requested.stdout).data).toHaveLength(2)
    expect(await readFile(config, 'utf-8')).toContain('node1')
  })
})
