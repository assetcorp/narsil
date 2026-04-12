import { buildCaExtensions, buildNodeExtensions, buildSanExtension } from '../../crypto/extensions'

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
