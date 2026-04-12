import forge from 'node-forge'
import { computeFingerprint } from '../../crypto/fingerprint'
import { generateKeyPair } from '../../crypto/keys'

function makeSelfSignedCert(cn: string) {
  const pair = generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = pair.publicKey
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16))
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.setSubject([{ name: 'commonName', value: cn }])
  cert.setIssuer([{ name: 'commonName', value: cn }])
  cert.sign(pair.privateKey, forge.md.sha256.create())
  return cert
}

describe('computeFingerprint', () => {
  it('returns colon-separated uppercase hex', () => {
    const cert = makeSelfSignedCert('test-fp')
    const fp = computeFingerprint(cert)

    const parts = fp.split(':')
    expect(parts.length).toBe(32)
    for (const part of parts) {
      expect(part).toMatch(/^[0-9A-F]{2}$/)
    }
  })

  it('returns the same fingerprint for the same cert', () => {
    const cert = makeSelfSignedCert('deterministic')
    const fp1 = computeFingerprint(cert)
    const fp2 = computeFingerprint(cert)
    expect(fp1).toBe(fp2)
  })

  it('returns different fingerprints for different certs', () => {
    const certA = makeSelfSignedCert('cert-a')
    const certB = makeSelfSignedCert('cert-b')
    const fpA = computeFingerprint(certA)
    const fpB = computeFingerprint(certB)
    expect(fpA).not.toBe(fpB)
  })
})
