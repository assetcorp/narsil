import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { generateCaCertificate } from '../../crypto/ca'
import { generateNodeCertificate } from '../../crypto/certificate'
import { pemToCertificate, pemToPrivateKey } from '../../crypto/pem'
import { pemToPkcs12, pkcs12ToPem } from '../../crypto/pkcs12'

const execFileAsync = promisify(execFile)

describe('PKCS#12 conversions', () => {
  const ca = generateCaCertificate({ name: 'P12 Test CA', days: 3650, keySize: 2048 })
  const node = generateNodeCertificate({
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    cn: 'p12-node',
    ipSans: ['127.0.0.1'],
    dnsSans: ['p12.local'],
    days: 365,
    keySize: 2048,
  })

  it('round-trips PEM to PKCS#12 and back without a CA cert', () => {
    const p12Bytes = pemToPkcs12(node.certPem, node.keyPem, 'test-password')
    expect(p12Bytes).toBeInstanceOf(Uint8Array)
    expect(p12Bytes.length).toBeGreaterThan(0)

    const restored = pkcs12ToPem(p12Bytes, 'test-password')
    const originalCert = pemToCertificate(node.certPem)
    const restoredCert = pemToCertificate(restored.certPem)
    expect(restoredCert.subject.getField('CN').value).toBe(originalCert.subject.getField('CN').value)

    const originalKey = pemToPrivateKey(node.keyPem)
    const restoredKey = pemToPrivateKey(restored.keyPem)
    expect(restoredKey.n.toString(16)).toBe(originalKey.n.toString(16))
  })

  it('round-trips with a CA cert included', () => {
    const p12Bytes = pemToPkcs12(node.certPem, node.keyPem, 'with-ca', ca.certPem)
    const restored = pkcs12ToPem(p12Bytes, 'with-ca')

    expect(restored.certPem).toContain('-----BEGIN CERTIFICATE-----')
    expect(restored.keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----')
    expect(restored.caCertPems.length).toBeGreaterThanOrEqual(1)

    const caCertRestored = pemToCertificate(restored.caCertPems[0])
    expect(caCertRestored.subject.getField('CN').value).toBe('P12 Test CA')
  })

  it('fails with the wrong password', () => {
    const p12Bytes = pemToPkcs12(node.certPem, node.keyPem, 'correct-password')
    expect(() => pkcs12ToPem(p12Bytes, 'wrong-password')).toThrow()
  })

  it('is readable via openssl pkcs12 for cert, CA, and private key material', async () => {
    const password = 'openssl-password'
    const p12Bytes = pemToPkcs12(node.certPem, node.keyPem, password, ca.certPem)
    const dir = join(tmpdir(), `certutil-pkcs12-${randomBytes(8).toString('hex')}`)
    const archivePath = join(dir, 'node.p12')

    try {
      await mkdir(dir, { recursive: true })
      await writeFile(archivePath, p12Bytes)

      const [clientCertOutput, caCertOutput, keyOutput] = await Promise.all([
        execFileAsync('openssl', ['pkcs12', '-in', archivePath, '-passin', `pass:${password}`, '-clcerts', '-nokeys']),
        execFileAsync('openssl', ['pkcs12', '-in', archivePath, '-passin', `pass:${password}`, '-cacerts', '-nokeys']),
        execFileAsync('openssl', ['pkcs12', '-in', archivePath, '-passin', `pass:${password}`, '-nocerts', '-nodes']),
      ])

      expect(clientCertOutput.stdout).toContain('BEGIN CERTIFICATE')
      expect(clientCertOutput.stdout).toContain('p12-node')

      expect(caCertOutput.stdout).toContain('BEGIN CERTIFICATE')
      expect(caCertOutput.stdout).toContain('P12 Test CA')

      expect(keyOutput.stdout).toContain('PRIVATE KEY')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
