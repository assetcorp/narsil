import forge from 'node-forge'
import { certificateToPem, pemToCertificate, pemToPrivateKey, privateKeyToPem } from './pem'

export function pemToPkcs12(certPem: string, keyPem: string, password: string, caCertPem?: string): Uint8Array {
  const cert = pemToCertificate(certPem)
  const key = pemToPrivateKey(keyPem)

  const certs: forge.pki.Certificate[] = [cert]
  if (caCertPem !== undefined) {
    certs.push(pemToCertificate(caCertPem))
  }

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(key, certs, password, {
    algorithm: '3des',
    generateLocalKeyId: true,
  })

  const derBytes = forge.asn1.toDer(p12Asn1).getBytes()
  const result = new Uint8Array(derBytes.length)
  for (let i = 0; i < derBytes.length; i++) {
    result[i] = derBytes.charCodeAt(i)
  }
  return result
}

export function pkcs12ToPem(
  p12Bytes: Uint8Array,
  password: string,
): { certPem: string; keyPem: string; caCertPems: string[] } {
  let binaryStr = ''
  for (let i = 0; i < p12Bytes.length; i++) {
    binaryStr += String.fromCharCode(p12Bytes[i])
  }

  const p12Asn1 = forge.asn1.fromDer(binaryStr)
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password)

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })

  const allCertBags = certBags[forge.pki.oids.certBag] ?? []
  const allKeyBags = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []

  if (allKeyBags.length === 0 || allKeyBags[0].key === undefined) {
    throw new Error('No private key found in PKCS#12 data')
  }

  const keyPem = privateKeyToPem(allKeyBags[0].key)

  let certPem = ''
  const caCertPems: string[] = []

  for (const bag of allCertBags) {
    if (bag.cert === undefined) continue
    const pem = certificateToPem(bag.cert)
    if (certPem === '' && bag.attributes?.localKeyId) {
      certPem = pem
    } else {
      caCertPems.push(pem)
    }
  }

  if (certPem === '' && allCertBags.length > 0 && allCertBags[0].cert !== undefined) {
    certPem = certificateToPem(allCertBags[0].cert)
  }

  if (certPem === '') {
    throw new Error('No certificate found in PKCS#12 data')
  }

  return { certPem, keyPem, caCertPems }
}
