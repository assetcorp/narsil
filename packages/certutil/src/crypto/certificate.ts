import forge from 'node-forge'
import type { CertOptions } from '../types'
import { buildNodeExtensions } from './extensions'
import { computeFingerprint } from './fingerprint'
import { generateKeyPair, publicKeysMatch } from './keys'
import { certificateToPem, pemToCertificate, pemToPrivateKey, privateKeyToPem } from './pem'
import { randomSerialNumber } from './serial'

export function isCertificateAuthority(certificate: forge.pki.Certificate): boolean {
  const constraints = certificate.getExtension('basicConstraints') as { cA?: boolean } | null
  return constraints?.cA === true
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
  if (!isCertificateAuthority(caCert)) {
    throw new Error('The certificate given as --ca-cert is not a certificate authority.')
  }
  if (!publicKeysMatch(caCert, caKey)) {
    throw new Error('The key given as --ca-key does not belong to the certificate given as --ca-cert.')
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
