import forge from 'node-forge'
import type { CaOptions } from '../types'
import { buildCaExtensions } from './extensions'
import { computeFingerprint } from './fingerprint'
import { generateKeyPair } from './keys'
import { certificateToPem, privateKeyToPem } from './pem'

function randomSerialNumber(): string {
  const bytes = forge.random.getBytesSync(16)
  return forge.util.bytesToHex(bytes)
}

export function generateCaCertificate(options: CaOptions): {
  certPem: string
  keyPem: string
  fingerprint: string
} {
  const { name, days, keySize } = options

  if (days <= 0 || !Number.isInteger(days)) {
    throw new Error(`Invalid validity period: ${days}. Must be a positive integer.`)
  }

  const keyPair = generateKeyPair(keySize)
  const cert = forge.pki.createCertificate()

  cert.publicKey = keyPair.publicKey
  cert.serialNumber = randomSerialNumber()

  const now = new Date()
  cert.validity.notBefore = now
  const notAfter = new Date(now)
  notAfter.setDate(notAfter.getDate() + days)
  cert.validity.notAfter = notAfter

  const subject = [{ name: 'commonName', value: name }]
  cert.setSubject(subject)
  cert.setIssuer(subject)

  cert.setExtensions(buildCaExtensions())

  cert.sign(keyPair.privateKey, forge.md.sha256.create())

  return {
    certPem: certificateToPem(cert),
    keyPem: privateKeyToPem(keyPair.privateKey),
    fingerprint: computeFingerprint(cert),
  }
}
