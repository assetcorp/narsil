import forge from 'node-forge'
import { generateKeyPair } from '../../crypto/keys'
import {
  certificateToPem,
  csrToPem,
  detectPemType,
  pemToCertificate,
  pemToCsr,
  pemToPrivateKey,
  privateKeyToPem,
} from '../../crypto/pem'

function makeSelfSignedCert(pair: { publicKey: forge.pki.rsa.PublicKey; privateKey: forge.pki.rsa.PrivateKey }) {
  const cert = forge.pki.createCertificate()
  cert.publicKey = pair.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.setSubject([{ name: 'commonName', value: 'test' }])
  cert.setIssuer([{ name: 'commonName', value: 'test' }])
  cert.sign(pair.privateKey, forge.md.sha256.create())
  return cert
}

describe('detectPemType', () => {
  it('detects a certificate', () => {
    const pair = generateKeyPair(2048)
    const cert = makeSelfSignedCert(pair)
    const pem = forge.pki.certificateToPem(cert)
    expect(detectPemType(pem)).toBe('certificate')
  })

  it('detects an RSA private key', () => {
    const pair = generateKeyPair(2048)
    const pem = forge.pki.privateKeyToPem(pair.privateKey)
    expect(detectPemType(pem)).toBe('private-key')
  })

  it('detects a CSR', () => {
    const pair = generateKeyPair(2048)
    const csr = forge.pki.createCertificationRequest()
    csr.publicKey = pair.publicKey
    csr.setSubject([{ name: 'commonName', value: 'test' }])
    csr.sign(pair.privateKey, forge.md.sha256.create())
    const pem = forge.pki.certificationRequestToPem(csr)
    expect(detectPemType(pem)).toBe('csr')
  })

  it('returns unknown for arbitrary text', () => {
    expect(detectPemType('not a PEM block')).toBe('unknown')
  })

  it('handles leading whitespace', () => {
    const pair = generateKeyPair(2048)
    const cert = makeSelfSignedCert(pair)
    const pem = `  \n${forge.pki.certificateToPem(cert)}`
    expect(detectPemType(pem)).toBe('certificate')
  })
})

describe('round-trip conversions', () => {
  it('round-trips a certificate through PEM', () => {
    const pair = generateKeyPair(2048)
    const original = makeSelfSignedCert(pair)
    const pem = certificateToPem(original)
    const restored = pemToCertificate(pem)

    expect(restored.subject.getField('CN').value).toBe('test')
    expect(restored.serialNumber).toBe(original.serialNumber)
  })

  it('round-trips a private key through PEM', () => {
    const pair = generateKeyPair(2048)
    const pem = privateKeyToPem(pair.privateKey)
    const restored = pemToPrivateKey(pem)

    expect(restored.n.toString(16)).toBe(pair.privateKey.n.toString(16))
  })

  it('round-trips a CSR through PEM', () => {
    const pair = generateKeyPair(2048)
    const csr = forge.pki.createCertificationRequest()
    csr.publicKey = pair.publicKey
    csr.setSubject([{ name: 'commonName', value: 'csr-test' }])
    csr.sign(pair.privateKey, forge.md.sha256.create())

    const pem = csrToPem(csr)
    const restored = pemToCsr(pem)

    expect(restored.subject.getField('CN').value).toBe('csr-test')
    expect(restored.verify()).toBe(true)
  })
})
