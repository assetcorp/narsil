import { generateCaCertificate } from '../../crypto/ca'
import { generateNodeCertificate } from '../../crypto/certificate'
import { buildCaExtensions, buildNodeExtensions, buildSanExtension } from '../../crypto/extensions'
import { pemToCertificate } from '../../crypto/pem'

describe('buildCaExtensions', () => {
  it('includes basicConstraints with cA set to true and critical', () => {
    const exts = buildCaExtensions()
    const bc = exts.find(e => e.name === 'basicConstraints')
    expect(bc).toBeDefined()
    expect(bc?.cA).toBe(true)
    expect(bc?.critical).toBe(true)
  })

  it('includes keyUsage with keyCertSign, cRLSign, and digitalSignature', () => {
    const exts = buildCaExtensions()
    const ku = exts.find(e => e.name === 'keyUsage')
    expect(ku).toBeDefined()
    expect(ku?.keyCertSign).toBe(true)
    expect(ku?.cRLSign).toBe(true)
    expect(ku?.digitalSignature).toBe(true)
    expect(ku?.critical).toBe(true)
  })
})

describe('buildNodeExtensions', () => {
  it('includes basicConstraints with cA set to false', () => {
    const exts = buildNodeExtensions(['127.0.0.1'], ['node.local'])
    const bc = exts.find(e => e.name === 'basicConstraints')
    expect(bc).toBeDefined()
    expect(bc?.cA).toBe(false)
  })

  it('includes extKeyUsage with serverAuth and clientAuth', () => {
    const exts = buildNodeExtensions(['127.0.0.1'], ['node.local'])
    const eku = exts.find(e => e.name === 'extKeyUsage')
    expect(eku).toBeDefined()
    expect(eku?.serverAuth).toBe(true)
    expect(eku?.clientAuth).toBe(true)
  })

  it('includes keyUsage with digitalSignature and keyEncipherment', () => {
    const exts = buildNodeExtensions(['127.0.0.1'], ['node.local'])
    const ku = exts.find(e => e.name === 'keyUsage')
    expect(ku).toBeDefined()
    expect(ku?.digitalSignature).toBe(true)
    expect(ku?.keyEncipherment).toBe(true)
  })

  it('includes subjectAltName extension', () => {
    const exts = buildNodeExtensions(['10.0.0.1'], ['host.example.com'])
    const san = exts.find(e => e.name === 'subjectAltName')
    expect(san).toBeDefined()
  })
})

describe('buildSanExtension', () => {
  it('includes IP addresses as type 7 entries', () => {
    const san = buildSanExtension(['192.168.1.1', '10.0.0.1'], [])
    expect(san.altNames?.length).toBe(2)
    for (const entry of san.altNames ?? []) {
      expect(entry.type).toBe(7)
      expect(entry.ip).toBeDefined()
    }
  })

  it('includes DNS names as type 2 entries', () => {
    const san = buildSanExtension([], ['a.example.com', 'b.example.com'])
    expect(san.altNames?.length).toBe(2)
    for (const entry of san.altNames ?? []) {
      expect(entry.type).toBe(2)
      expect(entry.value).toBeDefined()
    }
  })

  it('combines IP and DNS entries', () => {
    const san = buildSanExtension(['127.0.0.1'], ['localhost'])
    expect(san.altNames?.length).toBe(2)

    const dnsEntry = san.altNames?.find(e => e.type === 2)
    const ipEntry = san.altNames?.find(e => e.type === 7)
    expect(dnsEntry?.value).toBe('localhost')
    expect(ipEntry?.ip).toBe('127.0.0.1')
  })

  it('handles empty arrays', () => {
    const san = buildSanExtension([], [])
    expect(san.altNames?.length).toBe(0)
  })
})

describe('extensions in generated certificates', () => {
  const ca = generateCaCertificate({ name: 'Ext Verify CA', days: 3650, keySize: 2048 })
  const caCert = pemToCertificate(ca.certPem)

  const nodeResult = generateNodeCertificate({
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    cn: 'ext-verify-node',
    ipSans: ['172.16.0.1', '10.0.0.1'],
    dnsSans: ['ext-node.cluster.local', 'ext-node.internal'],
    days: 365,
    keySize: 2048,
  })
  const nodeCert = pemToCertificate(nodeResult.certPem)

  it('parses basicConstraints.cA as true in the CA certificate', () => {
    const bc = caCert.getExtension('basicConstraints') as { cA?: boolean } | null
    expect(bc).not.toBeNull()
    expect(bc?.cA).toBe(true)
  })

  it('parses keyUsage with keyCertSign, cRLSign, and digitalSignature in the CA certificate', () => {
    const ku = caCert.getExtension('keyUsage') as Record<string, unknown> | null
    expect(ku).not.toBeNull()
    expect(ku?.keyCertSign).toBe(true)
    expect(ku?.cRLSign).toBe(true)
    expect(ku?.digitalSignature).toBe(true)
  })

  it('parses basicConstraints.cA as false in the node certificate', () => {
    const bc = nodeCert.getExtension('basicConstraints') as { cA?: boolean } | null
    expect(bc).not.toBeNull()
    expect(bc?.cA).toBe(false)
  })

  it('parses extKeyUsage with serverAuth and clientAuth in the node certificate', () => {
    const eku = nodeCert.getExtension('extKeyUsage') as { serverAuth?: boolean; clientAuth?: boolean } | null
    expect(eku).not.toBeNull()
    expect(eku?.serverAuth).toBe(true)
    expect(eku?.clientAuth).toBe(true)
  })

  it('parses keyUsage with digitalSignature and keyEncipherment in the node certificate', () => {
    const ku = nodeCert.getExtension('keyUsage') as Record<string, unknown> | null
    expect(ku).not.toBeNull()
    expect(ku?.digitalSignature).toBe(true)
    expect(ku?.keyEncipherment).toBe(true)
  })

  it('parses subjectAltName with the requested IPs and DNS names in the node certificate', () => {
    const san = nodeCert.getExtension('subjectAltName') as {
      altNames?: Array<{ type: number; value?: string; ip?: string }>
    } | null
    expect(san).not.toBeNull()

    const ipEntries = san?.altNames?.filter(e => e.type === 7).map(e => e.ip) ?? []
    expect(ipEntries).toContain('172.16.0.1')
    expect(ipEntries).toContain('10.0.0.1')

    const dnsEntries = san?.altNames?.filter(e => e.type === 2).map(e => e.value) ?? []
    expect(dnsEntries).toContain('ext-node.cluster.local')
    expect(dnsEntries).toContain('ext-node.internal')
  })
})
