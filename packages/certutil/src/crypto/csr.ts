import forge from 'node-forge'
import type { CsrOptions } from '../types'
import { buildSanExtension } from './extensions'
import { generateKeyPair } from './keys'
import { csrToPem, privateKeyToPem } from './pem'

export function generateCsr(options: CsrOptions): {
  csrPem: string
  keyPem: string
} {
  const { cn, ipSans, dnsSans, keySize } = options

  const keyPair = generateKeyPair(keySize)
  const csr = forge.pki.createCertificationRequest()

  csr.publicKey = keyPair.publicKey
  csr.setSubject([{ name: 'commonName', value: cn }])

  const sanExt = buildSanExtension(ipSans, dnsSans)

  csr.setAttributes([
    {
      name: 'extensionRequest',
      extensions: [sanExt],
    },
  ])

  csr.sign(keyPair.privateKey, forge.md.sha256.create())

  return {
    csrPem: csrToPem(csr),
    keyPem: privateKeyToPem(keyPair.privateKey),
  }
}
