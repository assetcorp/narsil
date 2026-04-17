import forge from 'node-forge'

export function computeFingerprint(cert: forge.pki.Certificate): string {
  const derBytes = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  const md = forge.md.sha256.create()
  md.update(derBytes)
  const hex = md.digest().toHex()

  const pairs: string[] = []
  for (let i = 0; i < hex.length; i += 2) {
    pairs.push(hex.substring(i, i + 2).toUpperCase())
  }
  return pairs.join(':')
}
