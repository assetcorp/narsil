import { createPublicKey, type KeyObject, verify } from 'node:crypto'

const SEQUENCE_TAG = 0x30
const OBJECT_IDENTIFIER_TAG = 0x06
const OCTET_STRING_TAG = 0x04
const DNS_NAME_TAG = 0x82
const IP_ADDRESS_TAG = 0x87
const CONSTRUCTED_BIT = 0x20
const LONG_LENGTH_BIT = 0x80
const IPV4_BYTES = 4
const COMMON_NAME_OID = Buffer.from([0x55, 0x04, 0x03])
const SUBJECT_ALT_NAME_OID = Buffer.from([0x55, 0x1d, 0x11])
const SHA256_WITH_RSA_OID = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])

interface DerNode {
  tag: number
  start: number
  contentStart: number
  end: number
  children: DerNode[]
}

export interface ParsedCsr {
  commonName: string
  dnsNames: string[]
  ipAddresses: string[]
  publicKey: KeyObject
  signatureValid: boolean
}

function readNode(bytes: Buffer, start: number): DerNode {
  const tag = bytes.readUInt8(start)
  const firstLengthByte = bytes.readUInt8(start + 1)
  let contentStart = start + 2
  let length = firstLengthByte
  if ((firstLengthByte & LONG_LENGTH_BIT) !== 0) {
    const lengthBytes = firstLengthByte & ~LONG_LENGTH_BIT
    length = bytes.readUIntBE(contentStart, lengthBytes)
    contentStart += lengthBytes
  }
  const end = contentStart + length
  const children: DerNode[] = []
  if ((tag & CONSTRUCTED_BIT) !== 0) {
    let offset = contentStart
    while (offset < end) {
      const child = readNode(bytes, offset)
      children.push(child)
      offset = child.end
    }
  }
  return { tag, start, contentStart, end, children }
}

function childAt(node: DerNode, index: number): DerNode {
  const child = node.children[index]
  if (child === undefined) {
    throw new Error(`The DER node with tag ${node.tag} has no child at index ${index}`)
  }
  return child
}

function contentOf(bytes: Buffer, node: DerNode): Buffer {
  return bytes.subarray(node.contentStart, node.end)
}

function findCommonName(bytes: Buffer, subject: DerNode): string {
  for (const relativeName of subject.children) {
    const attribute = childAt(relativeName, 0)
    if (contentOf(bytes, childAt(attribute, 0)).equals(COMMON_NAME_OID)) {
      return contentOf(bytes, childAt(attribute, 1)).toString('utf8')
    }
  }
  throw new Error('The CSR subject has no common name')
}

function findSubjectAltNameValue(bytes: Buffer, node: DerNode): Buffer | undefined {
  const [first] = node.children
  if (
    node.tag === SEQUENCE_TAG &&
    first !== undefined &&
    first.tag === OBJECT_IDENTIFIER_TAG &&
    contentOf(bytes, first).equals(SUBJECT_ALT_NAME_OID)
  ) {
    const value = node.children.at(-1)
    if (value === undefined || value.tag !== OCTET_STRING_TAG) {
      throw new Error('The subjectAltName extension has no octet string value')
    }
    return contentOf(bytes, value)
  }
  for (const child of node.children) {
    const found = findSubjectAltNameValue(bytes, child)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

function readAlternativeNames(value: Buffer | undefined): { dnsNames: string[]; ipAddresses: string[] } {
  const dnsNames: string[] = []
  const ipAddresses: string[] = []
  if (value === undefined) {
    return { dnsNames, ipAddresses }
  }
  for (const name of readNode(value, 0).children) {
    const content = contentOf(value, name)
    if (name.tag === DNS_NAME_TAG) {
      dnsNames.push(content.toString('ascii'))
    } else if (name.tag === IP_ADDRESS_TAG && content.length === IPV4_BYTES) {
      ipAddresses.push([...content].join('.'))
    } else {
      throw new Error(`The CSR holds an alternative name with unexpected tag ${name.tag}`)
    }
  }
  return { dnsNames, ipAddresses }
}

export function parseCsr(pem: string): ParsedCsr {
  const base64 = pem.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, '').replace(/\s/g, '')
  const bytes = Buffer.from(base64, 'base64')
  const request = readNode(bytes, 0)
  const info = childAt(request, 0)
  const publicKeyInfo = childAt(info, 2)
  const algorithm = childAt(request, 1)
  const signature = childAt(request, 2)
  if (!contentOf(bytes, childAt(algorithm, 0)).equals(SHA256_WITH_RSA_OID)) {
    throw new Error('The CSR signature algorithm is not sha256WithRSAEncryption')
  }
  const publicKey = createPublicKey({
    key: bytes.subarray(publicKeyInfo.start, publicKeyInfo.end),
    format: 'der',
    type: 'spki',
  })
  const signedBytes = bytes.subarray(info.start, info.end)
  const signatureBytes = contentOf(bytes, signature).subarray(1)
  return {
    commonName: findCommonName(bytes, childAt(info, 1)),
    ...readAlternativeNames(findSubjectAltNameValue(bytes, childAt(info, 3))),
    publicKey,
    signatureValid: verify('sha256', signedBytes, publicKey, signatureBytes),
  }
}
