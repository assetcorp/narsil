import forge from 'node-forge'
import type { CertOptions } from '../types'
import { buildNodeExtensions } from './extensions'
import { computeFingerprint } from './fingerprint'
import { generateKeyPair } from './keys'
import { certificateToPem, pemToCertificate, pemToPrivateKey, privateKeyToPem } from './pem'

function randomSerialNumber(): string {
  const bytes = forge.random.getBytesSync(16)
  return forge.util.bytesToHex(bytes)
}

export function generateNodeCertificate(options: CertOptions): {
  certPem: string
  keyPem: string
  fingerprint: string
} {
  const { caCertPem, caKeyPem, cn, ipSans, dnsSans, days, keySize } = options

  if (days <= 0 || !Number.isInteger(days)) {
    throw new Error(`Invalid validity period: ${days}. Must be a positive integer.`)
  }

  const caCert = pemToCertificate(caCertPem)
  const caKey = pemToPrivateKey(caKeyPem)
  const keyPair = generateKeyPair(keySize)

  const cert = forge.pki.createCertificate()
  cert.publicKey = keyPair.publicKey
  cert.serialNumber = randomSerialNumber()

  const now = new Date()
  cert.validity.notBefore = now
  const notAfter = new Date(now)
  notAfter.setDate(notAfter.getDate() + days)
  cert.validity.notAfter = notAfter

  cert.setSubject([{ name: 'commonName', value: cn }])
  cert.setIssuer(caCert.subject.attributes)

  cert.setExtensions(buildNodeExtensions(ipSans, dnsSans))

  cert.sign(caKey, forge.md.sha256.create())

  return {
    certPem: certificateToPem(cert),
    keyPem: privateKeyToPem(keyPair.privateKey),
    fingerprint: computeFingerprint(cert),
  }
}
