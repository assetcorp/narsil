import forge from 'node-forge'

const PEM_CERT_HEADER = '-----BEGIN CERTIFICATE-----'
const PEM_KEY_HEADER = '-----BEGIN RSA PRIVATE KEY-----'
const PEM_PKCS8_KEY_HEADER = '-----BEGIN PRIVATE KEY-----'
const PEM_ENCRYPTED_KEY_HEADER = '-----BEGIN ENCRYPTED PRIVATE KEY-----'
const PEM_CSR_HEADER = '-----BEGIN CERTIFICATE REQUEST-----'

export function detectPemType(pem: string): 'certificate' | 'private-key' | 'csr' | 'unknown' {
  const trimmed = pem.trimStart()
  if (trimmed.startsWith(PEM_CERT_HEADER)) {
    return 'certificate'
  }
  if (
    trimmed.startsWith(PEM_KEY_HEADER) ||
    trimmed.startsWith(PEM_PKCS8_KEY_HEADER) ||
    trimmed.startsWith(PEM_ENCRYPTED_KEY_HEADER)
  ) {
    return 'private-key'
  }
  if (trimmed.startsWith(PEM_CSR_HEADER)) {
    return 'csr'
  }
  return 'unknown'
}

export function certificateToPem(cert: forge.pki.Certificate): string {
  return forge.pki.certificateToPem(cert)
}

export function privateKeyToPem(key: forge.pki.rsa.PrivateKey): string {
  return forge.pki.privateKeyToPem(key)
}

export function csrToPem(csr: forge.pki.CertificateSigningRequest): string {
  return forge.pki.certificationRequestToPem(csr)
}

export function pemToCertificate(pem: string): forge.pki.Certificate {
  return forge.pki.certificateFromPem(pem)
}

export function pemToPrivateKey(pem: string): forge.pki.rsa.PrivateKey {
  return forge.pki.privateKeyFromPem(pem)
}

export function pemToCsr(pem: string): forge.pki.CertificateSigningRequest {
  return forge.pki.certificationRequestFromPem(pem)
}
