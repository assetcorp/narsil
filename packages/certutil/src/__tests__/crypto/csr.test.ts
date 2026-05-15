import { generateCsr } from '../../crypto/csr'
import { pemToCsr, pemToPrivateKey } from '../../crypto/pem'

describe('generateCsr', () => {
  const result = generateCsr({
    cn: 'narsil-node-02',
    ipSans: ['10.0.0.5'],
    dnsSans: ['node02.narsil.local', 'node02.internal'],
    keySize: 2048,
  })

  it('produces valid PEM for both CSR and key', () => {
    expect(result.csrPem).toContain('-----BEGIN CERTIFICATE REQUEST-----')
    expect(result.keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----')
  })

  it('has the correct subject CN', () => {
    const csr = pemToCsr(result.csrPem)
    expect(csr.subject.getField('CN').value).toBe('narsil-node-02')
  })

  it('has SANs in the extensionRequest attribute', () => {
    const csr = pemToCsr(result.csrPem)
    const attrs = csr.getAttribute({ name: 'extensionRequest' })
    expect(attrs).toBeDefined()

    const extensions =
      (
        attrs as {
          extensions?: Array<{ name: string; altNames?: Array<{ type: number; value?: string; ip?: string }> }>
        }
      ).extensions ?? []
    const san = extensions.find(e => e.name === 'subjectAltName')
    expect(san).toBeDefined()

    const dnsEntries = san?.altNames?.filter(e => e.type === 2).map(e => e.value) ?? []
    expect(dnsEntries).toContain('node02.narsil.local')
    expect(dnsEntries).toContain('node02.internal')

    const ipEntries = san?.altNames?.filter(e => e.type === 7).map(e => e.ip) ?? []
    expect(ipEntries).toContain('10.0.0.5')
  })

  it('has a valid signature', () => {
    const csr = pemToCsr(result.csrPem)
    expect(csr.verify()).toBe(true)
  })

  it('key matches the CSR public key', () => {
    const csr = pemToCsr(result.csrPem)
    const key = pemToPrivateKey(result.keyPem)
    const csrPubN = (csr.publicKey as { n: { toString: (radix: number) => string } }).n.toString(16)
    const keyN = key.n.toString(16)
    expect(csrPubN).toBe(keyN)
  })
})
