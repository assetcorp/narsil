import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateCaCertificate, generateNodeCertificate } from '@delali/narsil-certutil'
import { certificateSansOf, NODES } from '../topology'

const CERT_DIR = process.env.CERT_DIR ?? '/certs'
const CERT_VALIDITY_DAYS = 365
const CERT_KEY_SIZE = 2048
const LOOPBACK_IP = '127.0.0.1'
const PRIVATE_KEY_MODE = 0o600

mkdirSync(CERT_DIR, { recursive: true })

const ca = generateCaCertificate({
  name: 'narsil-cluster-dashboard',
  days: CERT_VALIDITY_DAYS,
  keySize: CERT_KEY_SIZE,
})

writeFileSync(join(CERT_DIR, 'ca.crt'), ca.certPem)
writeFileSync(join(CERT_DIR, 'ca.key'), ca.keyPem, { mode: PRIVATE_KEY_MODE })

for (const spec of NODES) {
  const certificate = generateNodeCertificate({
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    cn: spec.nodeId,
    ipSans: [LOOPBACK_IP],
    dnsSans: certificateSansOf(spec),
    days: CERT_VALIDITY_DAYS,
    keySize: CERT_KEY_SIZE,
  })

  writeFileSync(join(CERT_DIR, `${spec.nodeId}.crt`), certificate.certPem)
  writeFileSync(join(CERT_DIR, `${spec.nodeId}.key`), certificate.keyPem, { mode: PRIVATE_KEY_MODE })
}

console.log(`Wrote a certificate authority and ${NODES.length} node certificates to ${CERT_DIR}`)
