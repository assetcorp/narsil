import forge from 'node-forge'
import { generateCaCertificate } from '../../crypto/ca'
import { generateCsr } from '../../crypto/csr'
import { buildNodeExtensions } from '../../crypto/extensions'
import { publicKeysMatch } from '../../crypto/keys'
import { pemToCertificate, pemToCsr, pemToPrivateKey } from '../../crypto/pem'

const ca = generateCaCertificate({ name: 'CSR Flow CA', days: 3650, keySize: 2048 })

const csrResult = generateCsr({
  cn: 'csr-signed-node',
  ipSans: ['10.0.0.50'],
  dnsSans: ['csr-node.cluster.local'],
  keySize: 2048,
})

function signCsrWithCa(
  csrPem: string,
  caCertPem: string,
  caKeyPem: string,
  ipSans: string[],
  dnsSans: string[],
): forge.pki.Certificate {
  const csr = pemToCsr(csrPem)
  const caCert = pemToCertificate(caCertPem)
  const caKey = pemToPrivateKey(caKeyPem)

  const cert = forge.pki.createCertificate()
  if (csr.publicKey === null) {
    throw new Error('CSR has no public key')
  }
  cert.publicKey = csr.publicKey
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16))

  const now = new Date()
  cert.validity.notBefore = now
  const notAfter = new Date(now)
  notAfter.setDate(notAfter.getDate() + 365)
  cert.validity.notAfter = notAfter

  cert.setSubject(csr.subject.attributes)
  cert.setIssuer(caCert.subject.attributes)
  cert.setExtensions(buildNodeExtensions(ipSans, dnsSans))
  cert.sign(caKey, forge.md.sha256.create())

  return cert
}

describe('CSR-to-signed-certificate flow', () => {
  const signedCert = signCsrWithCa(csrResult.csrPem, ca.certPem, ca.keyPem, ['10.0.0.50'], ['csr-node.cluster.local'])

  it('produces a certificate whose signature validates against the CA', () => {
    const caCert = pemToCertificate(ca.certPem)
    expect(caCert.verify(signedCert)).toBe(true)
  })

  it('has a private key from the CSR that matches the signed certificate', () => {
    const csrPrivateKey = pemToPrivateKey(csrResult.keyPem)
    expect(publicKeysMatch(signedCert, csrPrivateKey)).toBe(true)
  })

  it('carries the SANs from the original CSR request into the signed cert', () => {
    const san = signedCert.getExtension('subjectAltName') as {
      altNames?: Array<{ type: number; value?: string; ip?: string }>
    } | null

    const ipEntries = san?.altNames?.filter(e => e.type === 7).map(e => e.ip) ?? []
    const dnsEntries = san?.altNames?.filter(e => e.type === 2).map(e => e.value) ?? []

    expect(ipEntries).toContain('10.0.0.50')
    expect(dnsEntries).toContain('csr-node.cluster.local')
  })

  it('sets the subject CN from the CSR', () => {
    expect(signedCert.subject.getField('CN').value).toBe('csr-signed-node')
  })

  it('sets the issuer CN from the CA', () => {
    expect(signedCert.issuer.getField('CN').value).toBe('CSR Flow CA')
  })
})
