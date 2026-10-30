import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSecureContext } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Authority,
  createAuthority,
  createWorkspace,
  expectNoPrivateKeyInOutput,
  expectRefusal,
  issueNodeCertificate,
  listFiles,
  loadIdentity,
  type NodeIdentity,
  parseEnvelope,
  removeWorkspace,
  runCli,
} from '../support/cli'
import { performMutualTlsHandshake } from '../support/tls'

const PASSWORD = 'correct horse battery staple'

describe('narsil-certutil convert', () => {
  let root: string
  let authority: Authority
  let server: NodeIdentity
  let client: NodeIdentity

  beforeAll(async () => {
    root = await createWorkspace()
    const pkiDir = await createWorkspace(root)
    authority = await createAuthority(pkiDir, 'Convert Test CA')
    server = await issueNodeCertificate(authority, pkiDir, 'convert-server', ['--ip', '127.0.0.1'])
    client = await issueNodeCertificate(authority, pkiDir, 'convert-client')
  })

  afterAll(async () => {
    await removeWorkspace(root)
  })

  async function createP12(outDir: string, extraArgs: string[] = []): Promise<string> {
    const result = await runCli([
      'convert',
      '--cert',
      server.certPath,
      '--key',
      server.keyPath,
      '--to',
      'p12',
      '--p12-password',
      PASSWORD,
      '--out-dir',
      outDir,
      ...extraArgs,
    ])
    if (result.code !== 0) {
      throw new Error(`The CLI refused to create the PKCS#12 file: ${result.stderr}`)
    }
    return join(outDir, 'certificate.p12')
  }

  it('produces a password-protected PKCS#12 file that serves real TLS traffic', async () => {
    const p12Path = await createP12(await createWorkspace(root), ['--ca-cert', authority.certPath])
    const pfx = await readFile(p12Path)

    expect(() => createSecureContext({ pfx, passphrase: 'not the password' })).toThrow()

    const result = await performMutualTlsHandshake({
      server: { ca: authority.certPem, pfx, passphrase: PASSWORD },
      client: { ca: authority.certPem, cert: client.certPem, key: client.keyPem },
    })

    expect(result.clientPeerCn).toBe('convert-server')
    expect(result.serverPeerCn).toBe('convert-client')
    expect(result.echoedPayload).toBe('server-ack')
  })

  it('restores the same certificate, key, and CA from a PKCS#12 file', async () => {
    const workDir = await createWorkspace(root)
    const p12Path = await createP12(workDir, ['--ca-cert', authority.certPath])
    const outDir = join(workDir, 'pem')

    const result = await runCli([
      'convert',
      '--p12',
      p12Path,
      '--to',
      'pem',
      '--p12-password',
      PASSWORD,
      '--out-dir',
      outDir,
      '--output',
      'json',
    ])

    expect(result.code).toBe(0)
    expectNoPrivateKeyInOutput(result)
    const envelope = parseEnvelope<{ format: string; files: string[] }>(result.stdout)
    expect(envelope.data?.format).toBe('pem')
    expect(envelope.data?.files).toEqual([join(outDir, 'cert.pem'), join(outDir, 'key.pem'), join(outDir, 'ca-0.pem')])
    const restored = await loadIdentity(join(outDir, 'cert.pem'), join(outDir, 'key.pem'))
    expect(restored.certificate.fingerprint256).toBe(server.certificate.fingerprint256)
    expect(restored.certificate.checkPrivateKey(restored.privateKey)).toBe(true)
    const restoredAuthority = await loadIdentity(join(outDir, 'ca-0.pem'), join(outDir, 'key.pem'))
    expect(restoredAuthority.certificate.fingerprint256).toBe(authority.certificate.fingerprint256)
  })

  it('accepts the password from NARSIL_P12_PASSWORD', async () => {
    const outDir = await createWorkspace(root)

    const result = await runCli(
      ['convert', '--cert', server.certPath, '--key', server.keyPath, '--to', 'p12', '--out-dir', outDir],
      { env: { NARSIL_P12_PASSWORD: PASSWORD } },
    )

    expect(result.code).toBe(0)
    const pfx = await readFile(join(outDir, 'certificate.p12'))
    expect(() => createSecureContext({ pfx, passphrase: PASSWORD })).not.toThrow()
  })

  it('refuses the wrong password and writes no PEM files', async () => {
    const workDir = await createWorkspace(root)
    const p12Path = await createP12(workDir)
    const outDir = join(workDir, 'pem')

    const result = await runCli([
      'convert',
      '--p12',
      p12Path,
      '--to',
      'pem',
      '--p12-password',
      'wrong',
      '--out-dir',
      outDir,
    ])

    expectRefusal(result, 1, /Invalid password/)
    expectNoPrivateKeyInOutput(result)
    expect(await listFiles(outDir)).toEqual([])
  })

  it('refuses truncated and garbage PKCS#12 files', async () => {
    const workDir = await createWorkspace(root)
    const whole = await readFile(await createP12(workDir))
    const truncatedPath = join(workDir, 'truncated.p12')
    const garbagePath = join(workDir, 'garbage.p12')
    await writeFile(truncatedPath, whole.subarray(0, 400))
    await writeFile(garbagePath, 'this was never a PKCS#12 file')
    const outDir = join(workDir, 'pem')

    for (const path of [truncatedPath, garbagePath]) {
      const result = await runCli([
        'convert',
        '--p12',
        path,
        '--to',
        'pem',
        '--p12-password',
        PASSWORD,
        '--out-dir',
        outDir,
      ])

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Error:')
      expect(await listFiles(outDir)).toEqual([])
    }
  })

  it('leaves an existing PKCS#12 file untouched without --force and replaces it with --force', async () => {
    const outDir = await createWorkspace(root)
    const p12Path = await createP12(outDir)
    const original = await readFile(p12Path)
    const args = [
      'convert',
      '--cert',
      client.certPath,
      '--key',
      client.keyPath,
      '--to',
      'p12',
      '--p12-password',
      PASSWORD,
      '--out-dir',
      outDir,
    ]

    const refused = await runCli(args)

    expectRefusal(refused, 1, /File already exists.*--force/)
    expect((await readFile(p12Path)).equals(original)).toBe(true)

    const forced = await runCli([...args, '--force'])

    expect(forced.code).toBe(0)
    expect((await readFile(p12Path)).equals(original)).toBe(false)
  })

  it('leaves existing PEM files untouched without --force', async () => {
    const outDir = await createWorkspace(root)
    const p12Path = await createP12(outDir)
    await writeFile(join(outDir, 'key.pem'), 'an operator key')
    await writeFile(join(outDir, 'cert.pem'), 'an operator certificate')

    const result = await runCli([
      'convert',
      '--p12',
      p12Path,
      '--to',
      'pem',
      '--p12-password',
      PASSWORD,
      '--out-dir',
      outDir,
    ])

    expectRefusal(result, 1, /File already exists/)
    expect(await readFile(join(outDir, 'key.pem'), 'utf-8')).toBe('an operator key')
    expect(await readFile(join(outDir, 'cert.pem'), 'utf-8')).toBe('an operator certificate')
  })

  it.each([
    [['--to', 'der', '--p12-password', PASSWORD], 2, /Invalid --to value/],
    [['--to', 'p12', '--cert', 'node.crt', '--key', 'node.key'], 2, /Password is required/],
    [['--to', 'p12', '--p12-password', PASSWORD], 2, /requires --cert and --key/],
    [['--to', 'pem', '--p12-password', PASSWORD], 2, /requires --p12/],
    [['--p12-password', PASSWORD], 1, /--to/],
    [['--to', 'p12', '--cert', 'absent.crt', '--key', 'absent.key', '--p12-password', PASSWORD], 1, /ENOENT/],
  ])('refuses the arguments %j and writes nothing', async (args, code, message) => {
    const cwd = await createWorkspace(root)

    const result = await runCli(['convert', ...args], { cwd })

    expectRefusal(result, code, message)
    expect(await listFiles(cwd)).toEqual([])
  })

  it('refuses a corrupted certificate or key and writes no PKCS#12 file', async () => {
    const outDir = await createWorkspace(root)
    const corruptPath = join(outDir, 'corrupt.pem')
    await writeFile(corruptPath, '-----BEGIN CERTIFICATE-----\nDEFINITELYNOTVALID\n-----END CERTIFICATE-----\n')
    const p12Dir = join(outDir, 'out')

    const result = await runCli([
      'convert',
      '--cert',
      corruptPath,
      '--key',
      server.keyPath,
      '--to',
      'p12',
      '--p12-password',
      PASSWORD,
      '--out-dir',
      p12Dir,
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Error:')
    expect(await listFiles(p12Dir)).toEqual([])
  })
})
