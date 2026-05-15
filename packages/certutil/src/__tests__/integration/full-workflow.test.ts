import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInspectAction } from '../../commands/inspect'
import { runVerifyAction } from '../../commands/verify'
import { generateCaCertificate } from '../../crypto/ca'
import { generateNodeCertificate } from '../../crypto/certificate'
import { computeFingerprint } from '../../crypto/fingerprint'
import { publicKeysMatch } from '../../crypto/keys'
import { pemToCertificate, pemToPrivateKey } from '../../crypto/pem'
import { ensureDirectory } from '../../output/writer'
import type { InspectResult, OutputEnvelope, VerifyResult } from '../../types'

function createTempDir(): string {
  return join(tmpdir(), `certutil-integration-test-${randomBytes(8).toString('hex')}`)
}

describe('certificate workflow integration', () => {
  let dir: string
  let originalExitCode: string | number | null | undefined
  let stdoutChunks: string[]
  let stderrChunks: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dir = createTempDir()
    await ensureDirectory(dir)
    originalExitCode = process.exitCode
    stdoutChunks = []
    stderrChunks = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk))
      return true
    })
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk))
      return true
    })
  })

  afterEach(async () => {
    process.exitCode = originalExitCode
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    await rm(dir, { recursive: true, force: true })
  })

  function collectStdout(): string {
    return stdoutChunks.join('')
  }

  describe('complete single-node workflow', () => {
    const caName = 'Integration Test CA'
    const nodeCn = 'integration-node1.narsil.cluster'
    const nodeIpSans = ['10.0.1.10', '127.0.0.1']
    const nodeDnsSans = ['node1.narsil.cluster']

    let ca: { certPem: string; keyPem: string; fingerprint: string }
    let node: { certPem: string; keyPem: string; fingerprint: string }

    beforeEach(async () => {
      ca = generateCaCertificate({ name: caName, days: 3650, keySize: 2048 })
      node = generateNodeCertificate({
        caCertPem: ca.certPem,
        caKeyPem: ca.keyPem,
        cn: nodeCn,
        ipSans: nodeIpSans,
        dnsSans: nodeDnsSans,
        days: 365,
        keySize: 2048,
      })

      await writeFile(join(dir, 'ca.crt'), ca.certPem)
      await writeFile(join(dir, 'node1.crt'), node.certPem)
      await writeFile(join(dir, 'node1.key'), node.keyPem)
    })

    it('inspect reports correct subject, issuer, SANs, mTLS extensions, and fingerprint', async () => {
      await runInspectAction(join(dir, 'node1.crt'), { output: 'json' })

      const envelope: OutputEnvelope<InspectResult> = JSON.parse(collectStdout())
      expect(envelope.status).toBe('success')

      const data = envelope.data
      expect(data).not.toBeNull()
      if (data === null) return

      expect(data.type).toBe('certificate')
      expect(data.subject?.CN).toBe(nodeCn)
      expect(data.issuer?.CN).toBe(caName)

      expect(data.ipSans).toEqual(expect.arrayContaining(nodeIpSans))
      expect(data.ipSans?.length).toBe(nodeIpSans.length)
      expect(data.dnsSans).toEqual(expect.arrayContaining(nodeDnsSans))
      expect(data.dnsSans?.length).toBe(nodeDnsSans.length)

      expect(data.extKeyUsage).toEqual(expect.arrayContaining(['serverAuth', 'clientAuth']))
      expect(data.keyUsage).toEqual(expect.arrayContaining(['digitalSignature', 'keyEncipherment']))

      expect(data.fingerprint).toBeTruthy()
      const fingerprintParts = data.fingerprint?.split(':') ?? []
      expect(fingerprintParts.length).toBe(32)
      for (const part of fingerprintParts) {
        expect(part).toMatch(/^[0-9A-F]{2}$/)
      }

      expect(data.publicKeyBits).toBe(2048)
    })

    it('verify confirms chain, key match, mTLS readiness, and no errors', async () => {
      await runVerifyAction({
        cert: join(dir, 'node1.crt'),
        key: join(dir, 'node1.key'),
        caCert: join(dir, 'ca.crt'),
        output: 'json',
      })

      const envelope: OutputEnvelope<VerifyResult> = JSON.parse(collectStdout())
      expect(envelope.status).toBe('success')

      const data = envelope.data
      expect(data).not.toBeNull()
      if (data === null) return

      expect(data.certKeyMatch).toBe(true)
      expect(data.chainValid).toBe(true)
      expect(data.notExpired).toBe(true)
      expect(data.keyUsageCorrect).toBe(true)
      expect(data.mtlsReady).toBe(true)
      expect(data.errors).toHaveLength(0)

      expect(process.exitCode).not.toBe(1)
    })
  })

  describe('multi-node workflow with distinct SANs', () => {
    const nodeSpecs = [
      { cn: 'node1.cluster.local', ipSans: ['10.0.1.1'], dnsSans: ['node1.cluster.local'] },
      { cn: 'node2.cluster.local', ipSans: ['10.0.1.2'], dnsSans: ['node2.cluster.local'] },
      {
        cn: 'node3.cluster.local',
        ipSans: ['10.0.1.3', '10.0.1.4'],
        dnsSans: ['node3.cluster.local', 'node3.internal'],
      },
    ]

    let ca: { certPem: string; keyPem: string; fingerprint: string }
    let nodeCerts: Array<{ certPem: string; keyPem: string; fingerprint: string }>

    beforeEach(() => {
      ca = generateCaCertificate({ name: 'Multi-Node Integration CA', days: 3650, keySize: 2048 })
      nodeCerts = nodeSpecs.map(spec =>
        generateNodeCertificate({
          caCertPem: ca.certPem,
          caKeyPem: ca.keyPem,
          cn: spec.cn,
          ipSans: spec.ipSans,
          dnsSans: spec.dnsSans,
          days: 365,
          keySize: 2048,
        }),
      )
    })

    it('each node cert chains to the CA', () => {
      const caCert = pemToCertificate(ca.certPem)

      for (const nodeCert of nodeCerts) {
        const cert = pemToCertificate(nodeCert.certPem)
        const verified = caCert.verify(cert)
        expect(verified).toBe(true)
      }
    })

    it('each node cert key matches its own key', () => {
      for (const nodeCert of nodeCerts) {
        const cert = pemToCertificate(nodeCert.certPem)
        const key = pemToPrivateKey(nodeCert.keyPem)
        expect(publicKeysMatch(cert, key)).toBe(true)
      }
    })

    it('each node cert carries its own SANs and not another node SANs', () => {
      for (let i = 0; i < nodeSpecs.length; i++) {
        const spec = nodeSpecs[i]
        const certObj = nodeCerts[i]
        const cert = pemToCertificate(certObj.certPem)

        const sanExt = cert.getExtension('subjectAltName') as {
          altNames?: Array<{ type: number; value?: string; ip?: string }>
        } | null

        expect(sanExt).not.toBeNull()
        if (sanExt === null) continue

        const altNames = sanExt.altNames ?? []
        const ipSans = altNames.filter(a => a.type === 7).map(a => a.ip ?? '')
        const dnsSans = altNames.filter(a => a.type === 2).map(a => a.value ?? '')

        expect(ipSans).toEqual(spec.ipSans)
        expect(dnsSans).toEqual(spec.dnsSans)

        const subjectCn = cert.subject.getField('CN')?.value
        expect(subjectCn).toBe(spec.cn)
      }
    })

    it('node certs have unique serial numbers', () => {
      const serials = new Set<string>()
      for (const nodeCert of nodeCerts) {
        const cert = pemToCertificate(nodeCert.certPem)
        serials.add(cert.serialNumber)
      }
      expect(serials.size).toBe(nodeCerts.length)
    })

    it('node certs have unique fingerprints', () => {
      const fingerprints = new Set(nodeCerts.map(nc => nc.fingerprint))
      expect(fingerprints.size).toBe(nodeCerts.length)
    })

    it('computed fingerprints match the returned fingerprints', () => {
      for (const nodeCert of nodeCerts) {
        const cert = pemToCertificate(nodeCert.certPem)
        const computed = computeFingerprint(cert)
        expect(computed).toBe(nodeCert.fingerprint)
      }
    })
  })

  describe('cross-CA isolation', () => {
    let ca1: { certPem: string; keyPem: string; fingerprint: string }
    let ca2: { certPem: string; keyPem: string; fingerprint: string }
    let nodeFromCa1: { certPem: string; keyPem: string; fingerprint: string }

    beforeEach(async () => {
      ca1 = generateCaCertificate({ name: 'Isolation CA-1', days: 3650, keySize: 2048 })
      ca2 = generateCaCertificate({ name: 'Isolation CA-2', days: 3650, keySize: 2048 })

      nodeFromCa1 = generateNodeCertificate({
        caCertPem: ca1.certPem,
        caKeyPem: ca1.keyPem,
        cn: 'cross-verify-node',
        ipSans: ['192.168.1.10'],
        dnsSans: ['cross.narsil.local'],
        days: 365,
        keySize: 2048,
      })

      await writeFile(join(dir, 'ca1.crt'), ca1.certPem)
      await writeFile(join(dir, 'ca2.crt'), ca2.certPem)
      await writeFile(join(dir, 'node.crt'), nodeFromCa1.certPem)
      await writeFile(join(dir, 'node.key'), nodeFromCa1.keyPem)
    })

    it('node cert validates against its own CA', () => {
      const caCert = pemToCertificate(ca1.certPem)
      const nodeCert = pemToCertificate(nodeFromCa1.certPem)
      expect(caCert.verify(nodeCert)).toBe(true)
    })

    it('node cert does NOT validate against a different CA', () => {
      const wrongCaCert = pemToCertificate(ca2.certPem)
      const nodeCert = pemToCertificate(nodeFromCa1.certPem)

      let chainFailed = false
      try {
        wrongCaCert.verify(nodeCert)
      } catch {
        chainFailed = true
      }

      if (!chainFailed) {
        expect(wrongCaCert.verify(nodeCert)).toBe(false)
      }
    })

    it('verify command reports chain failure against the wrong CA via JSON', async () => {
      await runVerifyAction({
        cert: join(dir, 'node.crt'),
        key: join(dir, 'node.key'),
        caCert: join(dir, 'ca2.crt'),
        output: 'json',
      })

      const envelope: OutputEnvelope<VerifyResult> = JSON.parse(collectStdout())
      const data = envelope.data
      expect(data).not.toBeNull()
      if (data === null) return

      expect(data.chainValid).toBe(false)
      expect(data.errors.length).toBeGreaterThanOrEqual(1)
      expect(process.exitCode).toBe(1)
    })

    it('verify command reports chain success against the correct CA via JSON', async () => {
      await runVerifyAction({
        cert: join(dir, 'node.crt'),
        key: join(dir, 'node.key'),
        caCert: join(dir, 'ca1.crt'),
        output: 'json',
      })

      const envelope: OutputEnvelope<VerifyResult> = JSON.parse(collectStdout())
      const data = envelope.data
      expect(data).not.toBeNull()
      if (data === null) return

      expect(data.chainValid).toBe(true)
      expect(data.certKeyMatch).toBe(true)
      expect(data.errors).toHaveLength(0)
      expect(process.exitCode).not.toBe(1)
    })
  })

  describe('cert-key mismatch across generations', () => {
    let ca: { certPem: string; keyPem: string; fingerprint: string }
    let node1: { certPem: string; keyPem: string; fingerprint: string }
    let node2: { certPem: string; keyPem: string; fingerprint: string }

    beforeEach(() => {
      ca = generateCaCertificate({ name: 'Mismatch Test CA', days: 3650, keySize: 2048 })

      node1 = generateNodeCertificate({
        caCertPem: ca.certPem,
        caKeyPem: ca.keyPem,
        cn: 'mismatch-node1',
        ipSans: ['10.0.2.1'],
        dnsSans: ['mismatch1.cluster.local'],
        days: 365,
        keySize: 2048,
      })

      node2 = generateNodeCertificate({
        caCertPem: ca.certPem,
        caKeyPem: ca.keyPem,
        cn: 'mismatch-node2',
        ipSans: ['10.0.2.2'],
        dnsSans: ['mismatch2.cluster.local'],
        days: 365,
        keySize: 2048,
      })
    })

    it('a cert matches its own key', () => {
      const cert1 = pemToCertificate(node1.certPem)
      const key1 = pemToPrivateKey(node1.keyPem)
      expect(publicKeysMatch(cert1, key1)).toBe(true)

      const cert2 = pemToCertificate(node2.certPem)
      const key2 = pemToPrivateKey(node2.keyPem)
      expect(publicKeysMatch(cert2, key2)).toBe(true)
    })

    it('a cert does NOT match a key from a different generation', () => {
      const cert1 = pemToCertificate(node1.certPem)
      const key2 = pemToPrivateKey(node2.keyPem)
      expect(publicKeysMatch(cert1, key2)).toBe(false)

      const cert2 = pemToCertificate(node2.certPem)
      const key1 = pemToPrivateKey(node1.keyPem)
      expect(publicKeysMatch(cert2, key1)).toBe(false)
    })

    it('verify command detects the mismatch via JSON', async () => {
      await writeFile(join(dir, 'node1.crt'), node1.certPem)
      await writeFile(join(dir, 'node2.key'), node2.keyPem)

      await runVerifyAction({
        cert: join(dir, 'node1.crt'),
        key: join(dir, 'node2.key'),
        output: 'json',
      })

      const envelope: OutputEnvelope<VerifyResult> = JSON.parse(collectStdout())
      const data = envelope.data
      expect(data).not.toBeNull()
      if (data === null) return

      expect(data.certKeyMatch).toBe(false)
      expect(data.errors.length).toBeGreaterThanOrEqual(1)
      expect(process.exitCode).toBe(1)
    })

    it('both node certs chain to the same CA despite having different keys', () => {
      const caCert = pemToCertificate(ca.certPem)
      const cert1 = pemToCertificate(node1.certPem)
      const cert2 = pemToCertificate(node2.certPem)

      expect(caCert.verify(cert1)).toBe(true)
      expect(caCert.verify(cert2)).toBe(true)
    })
  })
})
