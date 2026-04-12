import forge from 'node-forge'
import { generateCaCertificate } from '../../crypto/ca'
import { generateNodeCertificate } from '../../crypto/certificate'
import { pemToCertificate } from '../../crypto/pem'

describe('generateNodeCertificate', () => {
  const ca = generateCaCertificate({ name: 'Test CA', days: 3650, keySize: 2048 })

  const nodeResult = generateNodeCertificate({
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    cn: 'narsil-node-01',
    ipSans: ['192.168.1.10', '127.0.0.1'],
    dnsSans: ['node01.narsil.local'],
    days: 365,
    keySize: 2048,
  })

  it('is signed by the CA, verifiable through the chain', () => {
    const caCert = pemToCertificate(ca.certPem)
    const nodeCert = pemToCertificate(nodeResult.certPem)
    const caStore = forge.pki.createCaStore([caCert])
    expect(() => forge.pki.verifyCertificateChain(caStore, [nodeCert])).not.toThrow()
  })

  it('has the correct subject CN', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    expect(cert.subject.getField('CN').value).toBe('narsil-node-01')
  })

  it('has the issuer CN matching the CA', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    expect(cert.issuer.getField('CN').value).toBe('Test CA')
  })

  it('contains the requested IP SANs', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    const san = cert.getExtension('subjectAltName') as { altNames?: Array<{ type: number; ip?: string }> } | null
    const ipEntries = san?.altNames?.filter(e => e.type === 7).map(e => e.ip) ?? []
    expect(ipEntries).toContain('192.168.1.10')
    expect(ipEntries).toContain('127.0.0.1')
  })

  it('contains the requested DNS SANs', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    const san = cert.getExtension('subjectAltName') as { altNames?: Array<{ type: number; value?: string }> } | null
    const dnsEntries = san?.altNames?.filter(e => e.type === 2).map(e => e.value) ?? []
    expect(dnsEntries).toContain('node01.narsil.local')
  })

  it('has extKeyUsage with serverAuth and clientAuth for mTLS', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    const eku = cert.getExtension('extKeyUsage') as { serverAuth?: boolean; clientAuth?: boolean } | null
    expect(eku?.serverAuth).toBe(true)
    expect(eku?.clientAuth).toBe(true)
  })

  it('is NOT a CA certificate', () => {
    const cert = pemToCertificate(nodeResult.certPem)
    const bc = cert.getExtension('basicConstraints') as { cA?: boolean } | null
    expect(bc?.cA).toBe(false)
  })

  it('produces a valid fingerprint', () => {
    const parts = nodeResult.fingerprint.split(':')
    expect(parts.length).toBe(32)
  })

  it('throws for invalid validity periods', () => {
    expect(() =>
      generateNodeCertificate({
        caCertPem: ca.certPem,
        caKeyPem: ca.keyPem,
        cn: 'bad',
        ipSans: [],
        dnsSans: [],
        days: 0,
        keySize: 2048,
      }),
    ).toThrow('Invalid validity period')
  })
})
