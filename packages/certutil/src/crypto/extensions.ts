export interface CertExtension {
  name: string
  cA?: boolean
  critical?: boolean
  keyCertSign?: boolean
  cRLSign?: boolean
  digitalSignature?: boolean
  keyEncipherment?: boolean
  serverAuth?: boolean
  clientAuth?: boolean
  altNames?: Array<{ type: number; value?: string; ip?: string }>
}

export function buildSanExtension(ipSans: string[], dnsSans: string[]): CertExtension {
  const altNames: Array<{ type: number; value?: string; ip?: string }> = []

  for (const dns of dnsSans) {
    altNames.push({ type: 2, value: dns })
  }

  for (const ip of ipSans) {
    altNames.push({ type: 7, ip })
  }

  return {
    name: 'subjectAltName',
    altNames,
  }
}

export function buildCaExtensions(): CertExtension[] {
  return [
    {
      name: 'basicConstraints',
      cA: true,
      critical: true,
    },
    {
      name: 'keyUsage',
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
      critical: true,
    },
  ]
}

export function buildNodeExtensions(ipSans: string[], dnsSans: string[]): CertExtension[] {
  return [
    {
      name: 'basicConstraints',
      cA: false,
      critical: true,
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true,
    },
    buildSanExtension(ipSans, dnsSans),
  ]
}
