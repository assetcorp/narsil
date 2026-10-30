import { X509Certificate } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commonName,
  createAuthority,
  createWorkspace,
  daysUntilExpiry,
  expectNoPrivateKeyInOutput,
  expectRefusal,
  listFiles,
  loadIdentity,
  modulusBits,
  parseEnvelope,
  removeWorkspace,
  runCli,
} from '../support/cli'

describe('narsil-certutil ca', () => {
  let root: string

  beforeAll(async () => {
    root = await createWorkspace()
  })

  afterAll(async () => {
    await removeWorkspace(root)
  })

  it('creates a ten-year, 4096-bit, self-signed CA in a new nested directory by default', async () => {
    const outDir = join(await createWorkspace(root), 'nested', 'certs')

    const result = await runCli(['ca', '--name', 'Narsil CA', '--out-dir', outDir])

    expect(result.code).toBe(0)
    expectNoPrivateKeyInOutput(result)
    const { certificate, privateKey } = await loadIdentity(join(outDir, 'ca.crt'), join(outDir, 'ca.key'))
    expect(commonName(certificate.subject)).toBe('Narsil CA')
    expect(certificate.issuer).toBe(certificate.subject)
    expect(certificate.ca).toBe(true)
    expect(certificate.verify(certificate.publicKey)).toBe(true)
    expect(certificate.checkPrivateKey(privateKey)).toBe(true)
    expect(modulusBits(privateKey)).toBe(4096)
    expect(daysUntilExpiry(certificate)).toBe(3650)
  })

  it('reports the fingerprint and both files in a parsable JSON envelope', async () => {
    const outDir = await createWorkspace(root)

    const result = await runCli([
      'ca',
      '--name',
      'JSON CA',
      '--key-size',
      '2048',
      '--days',
      '30',
      '--out-dir',
      outDir,
      '--output',
      'json',
    ])

    expect(result.code).toBe(0)
    expectNoPrivateKeyInOutput(result)
    const envelope = parseEnvelope<{ files: Array<{ path: string; type: string }>; fingerprint: string }>(result.stdout)
    const certificate = new X509Certificate(await readFile(join(outDir, 'ca.crt')))
    expect(envelope.status).toBe('success')
    expect(envelope.data?.fingerprint).toBe(certificate.fingerprint256)
    expect(envelope.data?.files).toEqual([
      { path: join(outDir, 'ca.crt'), type: 'certificate' },
      { path: join(outDir, 'ca.key'), type: 'key' },
    ])
    expect(daysUntilExpiry(certificate)).toBe(30)
  })

  it('leaves an existing CA untouched without --force and replaces it with --force', async () => {
    const outDir = await createWorkspace(root)
    const original = await createAuthority(outDir, 'Original CA')

    const refused = await runCli(['ca', '--name', 'Replacement CA', '--key-size', '2048', '--out-dir', outDir])

    expectRefusal(refused, 1, /File already exists.*--force/)
    expect(await readFile(original.certPath, 'utf-8')).toBe(original.certPem)
    expect(await readFile(original.keyPath, 'utf-8')).toBe(original.keyPem)

    const forced = await runCli([
      'ca',
      '--name',
      'Replacement CA',
      '--key-size',
      '2048',
      '--out-dir',
      outDir,
      '--force',
    ])

    expect(forced.code).toBe(0)
    const replacement = await loadIdentity(original.certPath, original.keyPath)
    expect(commonName(replacement.certificate.subject)).toBe('Replacement CA')
    expect(replacement.certificate.checkPrivateKey(replacement.privateKey)).toBe(true)
  })

  it('creates neither files nor directories in a dry run', async () => {
    const outDir = join(await createWorkspace(root), 'never-created')

    const result = await runCli(['ca', '--name', 'Dry CA', '--key-size', '2048', '--out-dir', outDir, '--dry-run'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(join(outDir, 'ca.key'))
    expect(await listFiles(outDir)).toEqual([])
  })

  it.each([
    ['--days', '0', /Invalid --days/],
    ['--days', '-5', /Invalid --days/],
    ['--days', 'forever', /Invalid --days/],
    ['--key-size', '1024', /Invalid --key-size/],
    ['--key-size', 'large', /Invalid --key-size/],
  ])('refuses %s %s with exit code 2 and writes nothing', async (flag, value, message) => {
    const outDir = await createWorkspace(root)

    const text = await runCli(['ca', '--name', 'Bad CA', '--out-dir', outDir, flag, value])
    const json = await runCli(['ca', '--name', 'Bad CA', '--out-dir', outDir, flag, value, '--output', 'json'])

    expectRefusal(text, 2, message)
    expect(json.code).toBe(2)
    expect(json.stdout).toBe('')
    const envelope = parseEnvelope<null>(json.stderr)
    expect(envelope.status).toBe('error')
    expect(envelope.error?.code).toBe('BAD_ARGUMENTS')
    expect(await listFiles(outDir)).toEqual([])
  })

  it('refuses a missing --name', async () => {
    const outDir = await createWorkspace(root)

    const result = await runCli(['ca', '--out-dir', outDir])

    expectRefusal(result, 1, /--name/)
    expect(await listFiles(outDir)).toEqual([])
  })

  it('refuses an output directory underneath a regular file', async () => {
    const outDir = await createWorkspace(root)
    await writeFile(join(outDir, 'occupied'), 'a regular file')

    const result = await runCli([
      'ca',
      '--name',
      'CA',
      '--key-size',
      '2048',
      '--out-dir',
      join(outDir, 'occupied', 'certs'),
    ])

    expectRefusal(result, 1, /ENOTDIR/)
    expectNoPrivateKeyInOutput(result)
  })

  it('takes the output directory from NARSIL_CERT_OUT_DIR, and a flag overrides it', async () => {
    const fromEnvironment = await createWorkspace(root)
    const fromFlag = await createWorkspace(root)
    const env = { NARSIL_CERT_OUT_DIR: fromEnvironment }

    const first = await runCli(['ca', '--name', 'Env CA', '--key-size', '2048'], { env })
    const second = await runCli(['ca', '--name', 'Flag CA', '--key-size', '2048', '--out-dir', fromFlag], { env })

    expect(first.code).toBe(0)
    expect(second.code).toBe(0)
    expect(await listFiles(fromEnvironment)).toEqual(['ca.crt', 'ca.key'])
    expect(await listFiles(fromFlag)).toEqual(['ca.crt', 'ca.key'])
  })
})
