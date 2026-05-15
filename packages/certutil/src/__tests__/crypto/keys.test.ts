import forge from 'node-forge'
import { generateKeyPair, publicKeysMatch } from '../../crypto/keys'

describe('generateKeyPair', () => {
  it('produces a 2048-bit RSA key pair', () => {
    const pair = generateKeyPair(2048)
    expect(pair.publicKey).toBeDefined()
    expect(pair.privateKey).toBeDefined()
    const bits = (pair.publicKey as forge.pki.rsa.PublicKey).n.bitLength()
    expect(bits).toBe(2048)
  })

  it('produces a 4096-bit RSA key pair', () => {
    const pair = generateKeyPair(4096)
    const bits = (pair.publicKey as forge.pki.rsa.PublicKey).n.bitLength()
    expect(bits).toBe(4096)
  })

  it('throws for unsupported key sizes', () => {
    expect(() => generateKeyPair(1024)).toThrow('Unsupported key size')
    expect(() => generateKeyPair(512)).toThrow('Unsupported key size')
  })
})

describe('publicKeysMatch', () => {
  it('returns true when the cert and key are from the same pair', () => {
    const pair = generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = pair.publicKey
    cert.serialNumber = '01'
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date()
    cert.setSubject([{ name: 'commonName', value: 'test' }])
    cert.setIssuer([{ name: 'commonName', value: 'test' }])
    cert.sign(pair.privateKey, forge.md.sha256.create())

    expect(publicKeysMatch(cert, pair.privateKey)).toBe(true)
  })

  it('returns false when the cert and key are from different pairs', () => {
    const pairA = generateKeyPair(2048)
    const pairB = generateKeyPair(2048)

    const cert = forge.pki.createCertificate()
    cert.publicKey = pairA.publicKey
    cert.serialNumber = '01'
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date()
    cert.setSubject([{ name: 'commonName', value: 'test' }])
    cert.setIssuer([{ name: 'commonName', value: 'test' }])
    cert.sign(pairA.privateKey, forge.md.sha256.create())

    expect(publicKeysMatch(cert, pairB.privateKey)).toBe(false)
  })
})
