import { crc32 } from 'node:zlib'
import { decode, encode } from '@msgpack/msgpack'

const BLOCK = 512
const ENVELOPE_HEADER_BYTES = 32
const CHECKSUM_FLAG = 0b1000
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface TarEntry {
  name: string
  data: Uint8Array
  type?: number
}

export async function bytesOf(source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  if (source instanceof ReadableStream) {
    const reader = source.getReader()
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      chunks.push(step.value)
    }
  } else {
    for await (const chunk of source) chunks.push(chunk)
  }
  return joinBytes(chunks)
}

export function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function textField(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return textDecoder.decode(end === -1 ? field : field.subarray(0, end))
}

function octalField(block: Uint8Array, offset: number, length: number): number {
  const text = textField(block, offset, length).trim()
  return text.length === 0 ? 0 : Number.parseInt(text, 8)
}

function paxPath(data: Uint8Array): string | null {
  const text = textDecoder.decode(data)
  for (const line of text.split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(line)
    if (match !== null) return match[1]
  }
  return null
}

export function readTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  let pendingPath: string | null = null
  while (offset + BLOCK <= bytes.byteLength) {
    const block = bytes.subarray(offset, offset + BLOCK)
    if (block.every(byte => byte === 0)) break
    const size = octalField(block, 124, 12)
    const type = block[156]
    const prefix = textField(block, 345, 155)
    const shortName = textField(block, 0, 100)
    const data = bytes.slice(offset + BLOCK, offset + BLOCK + size)
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    if (type === 0x78) {
      pendingPath = paxPath(data)
      continue
    }
    const name = pendingPath ?? (prefix.length > 0 ? `${prefix}/${shortName}` : shortName)
    pendingPath = null
    entries.push({ name, data, type })
  }
  return entries
}

function headerBlock(name: string, size: number, type: number): Uint8Array {
  const block = new Uint8Array(BLOCK)
  block.set(textEncoder.encode(name).subarray(0, 100), 0)
  block.set(textEncoder.encode('0000644'), 100)
  block.set(textEncoder.encode('0000000'), 108)
  block.set(textEncoder.encode('0000000'), 116)
  block.set(textEncoder.encode(size.toString(8).padStart(11, '0')), 124)
  block.set(textEncoder.encode('00000000000'), 136)
  block[156] = type
  block.set(textEncoder.encode('ustar'), 257)
  block.set(textEncoder.encode('00'), 263)
  let sum = 0
  for (let at = 0; at < BLOCK; at++) sum += at >= 148 && at < 156 ? 0x20 : block[at]
  block.set(textEncoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148)
  return block
}

function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.byteLength / BLOCK) * BLOCK)
  out.set(data, 0)
  return out
}

function paxRecord(name: string): Uint8Array {
  const body = ` path=${name}\n`
  const bodyBytes = textEncoder.encode(body).byteLength
  let digits = 1
  while (String(bodyBytes + digits).length !== digits) digits += 1
  return textEncoder.encode(`${bodyBytes + digits}${body}`)
}

export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const entry of entries) {
    if (textEncoder.encode(entry.name).byteLength > 100) {
      const record = paxRecord(entry.name)
      parts.push(headerBlock('PaxHeader', record.byteLength, 0x78), padded(record))
    }
    parts.push(headerBlock(entry.name.slice(0, 100), entry.data.byteLength, entry.type ?? 0x30), padded(entry.data))
  }
  parts.push(new Uint8Array(BLOCK * 2))
  return joinBytes(parts)
}

export interface OpenedEnvelope {
  version: number
  payload: Uint8Array
}

export function openEnvelope(bytes: Uint8Array): OpenedEnvelope {
  if (textDecoder.decode(bytes.subarray(0, 4)) !== 'NRSL') throw new Error('not an NRSL file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = view.getUint32(8, false)
  const payload = bytes.slice(ENVELOPE_HEADER_BYTES, ENVELOPE_HEADER_BYTES + length)
  if (payload.byteLength !== length) throw new Error('the envelope ends before its payload')
  if ((view.getUint16(12, false) & CHECKSUM_FLAG) !== 0 && crc32(payload) !== view.getUint32(14, false)) {
    throw new Error('the envelope checksum does not match')
  }
  return { version: bytes[4], payload }
}

export function sealEnvelope(version: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(ENVELOPE_HEADER_BYTES + payload.byteLength)
  const view = new DataView(bytes.buffer)
  bytes.set(textEncoder.encode('NRSL'), 0)
  bytes[4] = version
  view.setUint32(8, payload.byteLength, false)
  view.setUint16(12, CHECKSUM_FLAG, false)
  view.setUint32(14, crc32(payload), false)
  bytes.set(payload, ENVELOPE_HEADER_BYTES)
  return bytes
}

export function decodedPayload(bytes: Uint8Array): Record<string, unknown> {
  return decode(openEnvelope(bytes).payload) as Record<string, unknown>
}

export function resealed(bytes: Uint8Array, change: (payload: Record<string, unknown>) => unknown): Uint8Array {
  const opened = openEnvelope(bytes)
  return sealEnvelope(opened.version, encode(change(decode(opened.payload) as Record<string, unknown>)))
}

interface ListedFileRef {
  key: string
  bytes: number
  checksum: number
}

function listedRefs(manifest: Record<string, unknown>): ListedFileRef[] {
  const partitions = manifest.partitions as Array<{ segments: ListedFileRef[] }>
  const vectors = manifest.vectors as Array<{ files: ListedFileRef[]; graphParts: ListedFileRef[] }>
  return [
    ...partitions.flatMap(partition => partition.segments),
    ...vectors.flatMap(field => [...field.files, ...field.graphParts]),
  ]
}

export function rewriteFiles(
  entries: readonly TarEntry[],
  change: (payload: Record<string, unknown>, name: string) => boolean,
): TarEntry[] {
  const replaced = new Map<string, Uint8Array>()
  for (const entry of entries.slice(2)) {
    const opened = openEnvelope(entry.data)
    const payload = decode(opened.payload) as Record<string, unknown>
    if (!change(payload, entry.name)) continue
    replaced.set(entry.name, sealEnvelope(opened.version, encode(payload)))
  }
  const manifest = resealed(entryNamed(entries, 'manifest').data, raw => {
    for (const ref of listedRefs(raw)) {
      const name = ref.key.slice(ref.key.indexOf('/') + 1)
      const data = replaced.get(name)
      if (data === undefined) continue
      ref.bytes = data.byteLength
      ref.checksum = crc32(openEnvelope(data).payload)
    }
    return raw
  })
  return entries.map(entry => {
    if (entry.name === 'manifest') return { ...entry, data: manifest }
    const data = replaced.get(entry.name)
    return data === undefined ? entry : { ...entry, data }
  })
}

export function uint32Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, i) => {
    view.setUint32(i * 4, value, true)
  })
  return bytes
}

export function uint32Values(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: Math.floor(bytes.byteLength / 4) }, (_, i) => view.getUint32(i * 4, true))
}

export function entryNamed(entries: readonly TarEntry[], name: string): TarEntry {
  const entry = entries.find(candidate => candidate.name === name)
  if (entry === undefined) throw new Error(`the archive holds no entry named ${name}`)
  return entry
}

export function withEntry(entries: readonly TarEntry[], name: string, data: Uint8Array): TarEntry[] {
  return entries.map(entry => (entry.name === name ? { ...entry, data } : entry))
}
