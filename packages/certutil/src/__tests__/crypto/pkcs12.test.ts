import { generateCaCertificate } from '../../crypto/ca'
import { generateNodeCertificate } from '../../crypto/certificate'
import { pemToCertificate, pemToPrivateKey } from '../../crypto/pem'
import { pemToPkcs12, pkcs12ToPem } from '../../crypto/pkcs12'

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
})
