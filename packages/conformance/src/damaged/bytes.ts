import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decode, encode } from '@msgpack/msgpack'
import { crc32 } from '../../../ts/src/serialization/crc32'
import { HEADER_SIZE } from '../../../ts/src/serialization/header'
import type { HeaderForm } from '../forms/header'
import { referenceContext } from '../reference/context'
import { packedEnvelope } from '../reference/envelope'
import { SAMPLES_ROOT } from '../samples/catalog'

export const CHECKSUM_OFFSET = 14
export const PAYLOAD_LENGTH_OFFSET = 8
export const FLAGS_OFFSET = 12

export type RawMap = Record<string, unknown>

interface RawEnvelope {
  header: HeaderForm
  payload: RawMap
}

export function checkpointPath(indexName: string): string {
  return `checkpoints/${indexName}`
}

export async function baseFile(indexName: string, relative: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(SAMPLES_ROOT, checkpointPath(indexName), relative)))
}

function isRawMap(value: unknown): value is RawMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array)
}

export function mapAt(value: unknown, what: string): RawMap {
  if (!isRawMap(value)) throw new Error(`${what} is not a map`)
  return value
}

export function listAt(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list`)
  return value
}

export function bytesAt(value: unknown, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${what} is not bytes`)
  return value
}

export async function openRaw(bytes: Uint8Array, what: string): Promise<RawEnvelope> {
  const { header, payload } = await referenceContext.openEnvelope(bytes, what)
  return { header, payload: mapAt(decode(payload), what) }
}

async function packRaw(envelope: RawEnvelope): Promise<Uint8Array> {
  return packedEnvelope([encode(envelope.payload)], envelope.header)
}

export async function rewritten(bytes: Uint8Array, what: string, change: (payload: RawMap) => void) {
  const envelope = await openRaw(bytes, what)
  change(envelope.payload)
  return packRaw(envelope)
}

export async function gzippedEnvelope(bytes: Uint8Array, what: string): Promise<Uint8Array> {
  const envelope = await openRaw(bytes, what)
  return packRaw({ header: { ...envelope.header, compression: 'gzip' }, payload: envelope.payload })
}

export function otherChecksum(listed: unknown): number {
  return (Number(listed) ^ 1) >>> 0
}

export function headerChecksumOf(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(CHECKSUM_OFFSET, false)
}

export function withPayloadChecksum(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice()
  new DataView(copy.buffer).setUint32(CHECKSUM_OFFSET, crc32(copy.subarray(HEADER_SIZE)), false)
  return copy
}

export function withBytesAt(bytes: Uint8Array, offset: number, values: readonly number[]): Uint8Array {
  const copy = bytes.slice()
  copy.set(values, offset)
  return copy
}

export function uint32s(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 4 }, (_, at) => view.getUint32(at * 4, true))
}

export function float64s(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 8 }, (_, at) => view.getFloat64(at * 8, true))
}

export function packedUint32s(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  for (const [at, value] of values.entries()) view.setUint32(at * 4, value, true)
  return bytes
}

export function packedFloat64s(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 8)
  const view = new DataView(bytes.buffer)
  for (const [at, value] of values.entries()) view.setFloat64(at * 8, value, true)
  return bytes
}

export function packedUint64s(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 8)
  const view = new DataView(bytes.buffer)
  for (const [at, value] of values.entries()) view.setBigUint64(at * 8, BigInt(value), true)
  return bytes
}

function refsOf(manifest: RawMap): RawMap[] {
  const refs: RawMap[] = []
  for (const partition of listAt(manifest.partitions, 'partitions')) {
    for (const segment of listAt(mapAt(partition, 'partition').segments, 'segments')) refs.push(mapAt(segment, 'ref'))
  }
  for (const field of listAt(manifest.vectors ?? [], 'vectors')) {
    const vectors = mapAt(field, 'vector field')
    for (const file of listAt(vectors.files, 'files')) refs.push(mapAt(file, 'file ref'))
    for (const part of listAt(vectors.graphParts, 'graphParts')) refs.push(mapAt(part, 'graph part ref'))
  }
  return refs
}

export function fittedManifestPayload(manifest: RawMap, indexName: string, files: ReadonlyMap<string, Uint8Array>) {
  for (const ref of refsOf(manifest)) {
    const key = ref.key
    if (typeof key !== 'string' || !key.startsWith(`${indexName}/`)) continue
    const changed = files.get(key.slice(indexName.length + 1))
    if (changed === undefined) continue
    ref.bytes = changed.byteLength
    ref.checksum = headerChecksumOf(changed)
    if (typeof ref.headOffset === 'number' && typeof ref.headLength === 'number') {
      const start = HEADER_SIZE + ref.headOffset
      ref.headChecksum = crc32(changed.subarray(start, start + ref.headLength))
    }
  }
}

export async function fittedManifest(indexName: string, files: ReadonlyMap<string, Uint8Array>) {
  const manifest = files.get('manifest') ?? (await baseFile(indexName, 'manifest'))
  return rewritten(manifest, `${indexName} manifest`, payload => fittedManifestPayload(payload, indexName, files))
}
