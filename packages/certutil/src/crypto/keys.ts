import forge from 'node-forge'

export function generateKeyPair(bits: number): {
  publicKey: forge.pki.rsa.PublicKey
  privateKey: forge.pki.rsa.PrivateKey
} {
  if (bits !== 2048 && bits !== 4096) {
    throw new Error(`Unsupported key size: ${bits}. Use 2048 or 4096.`)
  }
  return forge.pki.rsa.generateKeyPair({ bits, e: 0x10001 })
}

export function publicKeysMatch(cert: forge.pki.Certificate, key: forge.pki.rsa.PrivateKey): boolean {
  const certPubKey = cert.publicKey as forge.pki.rsa.PublicKey
  if (!certPubKey.n || !key.n) {
    return false
  }
  return certPubKey.n.toString(16) === key.n.toString(16)
}
