import forge from 'node-forge'
import { generateCaCertificate } from '../../crypto/ca'
import { pemToCertificate, pemToPrivateKey } from '../../crypto/pem'

describe('generateCaCertificate', () => {
  const result = generateCaCertificate({ name: 'Narsil Test CA', days: 365, keySize: 2048 })

  it('produces valid PEM for both cert and key', () => {
    expect(result.certPem).toContain('-----BEGIN CERTIFICATE-----')
    expect(result.keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----')
  })

  it('is self-signed, meaning issuer equals subject', () => {
    const cert = pemToCertificate(result.certPem)
    const subjectCN = cert.subject.getField('CN').value
    const issuerCN = cert.issuer.getField('CN').value
    expect(subjectCN).toBe('Narsil Test CA')
    expect(issuerCN).toBe('Narsil Test CA')
  })

  it('has basicConstraints with cA set to true', () => {
    const cert = pemToCertificate(result.certPem)
    const bc = cert.getExtension('basicConstraints') as { cA?: boolean } | null
    expect(bc).not.toBeNull()
    expect(bc?.cA).toBe(true)
  })

  it('respects the requested validity period', () => {
    const cert = pemToCertificate(result.certPem)
    const diffMs = cert.validity.notAfter.getTime() - cert.validity.notBefore.getTime()
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
    expect(diffDays).toBe(365)
  })

  it('matches the requested key size', () => {
    const key = pemToPrivateKey(result.keyPem)
    expect(key.n.bitLength()).toBe(2048)
  })

  it('produces a valid fingerprint', () => {
    const parts = result.fingerprint.split(':')
    expect(parts.length).toBe(32)
    for (const part of parts) {
      expect(part).toMatch(/^[0-9A-F]{2}$/)
    }
  })

  it('can verify its own signature', () => {
    const cert = pemToCertificate(result.certPem)
    const caStore = forge.pki.createCaStore([cert])
    expect(() => forge.pki.verifyCertificateChain(caStore, [cert])).not.toThrow()
  })

  it('throws for invalid validity periods', () => {
    expect(() => generateCaCertificate({ name: 'bad', days: 0, keySize: 2048 })).toThrow('Invalid validity period')
    expect(() => generateCaCertificate({ name: 'bad', days: -1, keySize: 2048 })).toThrow('Invalid validity period')
    expect(() => generateCaCertificate({ name: 'bad', days: 1.5, keySize: 2048 })).toThrow('Invalid validity period')
  })
})
