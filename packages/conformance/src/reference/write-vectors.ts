import { encode } from '@msgpack/msgpack'
import { vectorPartChunks } from '../../../ts/src/persistence/durability/segment/vector-part-bytes'
import { pagedGraphPartChunks, pagedVectorFileChunks } from '../../../ts/src/persistence/paged/vector-bytes'
import { packChecksummedEnvelope } from '../../../ts/src/serialization/envelope-file'
import {
  decodeVectorFilePayload,
  decodeVectorGraphPartPayload,
} from '../../../ts/src/vector/vector-index/checkpoint-payload'
import { FormError } from '../forms/decoded'
import { headerFromJson } from '../forms/header'
import { type Json, type JsonObject, untagged } from '../forms/json'
import { numberFromJson, numbersFromJson } from '../forms/numbers'
import { plainOf } from './context'
import { joined, packedEnvelope } from './envelope'
import { listAt, objectAt } from './write-envelopes'

const OSQ_RECORD_TAIL_BYTES = 16
const BITS_PER_BYTE = 8

export interface WrittenFile {
  bytes: Uint8Array
  headOffset?: number
  headLength?: number
  headChecksum?: number
}

function storageOf(json: JsonObject, what: string): 'memory' | 'disk' {
  if (json.storage !== 'memory' && json.storage !== 'disk') throw new FormError(`${what}.storage is not memory or disk`)
  return json.storage
}

function envelopeVersionOfCheckpointFile(json: JsonObject, what: string): number {
  const header = headerFromJson(json.header, `${what} header`)
  if (header.compression !== 'none' || !header.checksum) {
    throw new FormError(`${what} header must be uncompressed and carry a checksum, as every checkpoint file does`)
  }
  return header.envelopeFormatVersion
}

function recordsBytes(records: Json[], dimension: number, bits: number, what: string): Uint8Array {
  const codeBytes = Math.ceil((dimension * bits) / BITS_PER_BYTE)
  const recordBytes = codeBytes + OSQ_RECORD_TAIL_BYTES
  const bytes = new Uint8Array(records.length * recordBytes)
  const view = new DataView(bytes.buffer)
  records.forEach((entry, at) => {
    const record = objectAt(entry, `${what}[${at}]`)
    const code = numbersFromJson(listAt(record.code, `${what}[${at}].code`), 'uint8', `${what}[${at}].code`)
    if (code.byteLength !== codeBytes) throw new FormError(`${what}[${at}].code holds ${code.byteLength} bytes`)
    const start = at * recordBytes
    bytes.set(code, start)
    view.setFloat32(start + codeBytes, numberFromJson(record.lower ?? null, `${what}[${at}].lower`), true)
    view.setFloat32(start + codeBytes + 4, numberFromJson(record.upper ?? null, `${what}[${at}].upper`), true)
    view.setFloat32(start + codeBytes + 8, numberFromJson(record.correction ?? null, `${what}[${at}].correction`), true)
    view.setUint32(start + codeBytes + 12, numberFromJson(record.sum ?? null, `${what}[${at}].sum`), true)
  })
  return bytes
}

function vectorFileRaw(payload: JsonObject, what: string): Record<string, unknown> {
  const dimension = numberFromJson(payload.dimension ?? null, `${what}.dimension`)
  const vectors = listAt(payload.vectors, `${what}.vectors`).flatMap((vector, at) =>
    listAt(vector, `${what}.vectors[${at}]`),
  )
  const raw: Record<string, unknown> = {
    v: plainOf(untagged(payload.v ?? null), `${what}.v`),
    fieldName: payload.fieldName,
    dimension,
    docIds: plainOf(untagged(payload.docIds ?? null), `${what}.docIds`),
    codes: null,
    vectors: numbersFromJson(vectors, 'float32', `${what}.vectors`),
  }
  if (payload.codes !== null && payload.codes !== undefined) {
    const codes = objectAt(payload.codes, `${what}.codes`)
    const bits = numberFromJson(codes.bits ?? null, `${what}.codes.bits`)
    raw.codes = {
      bits,
      centroid: plainOf(untagged(codes.centroid ?? null), `${what}.codes.centroid`),
      records: recordsBytes(listAt(codes.records, `${what}.codes.records`), dimension, bits, `${what}.codes.records`),
    }
  }
  return raw
}

export async function writeVectorFile(json: JsonObject, what: string): Promise<WrittenFile> {
  const version = envelopeVersionOfCheckpointFile(json, what)
  const payloadJson = objectAt(json.payload, `${what}.payload`)
  const payload = decodeVectorFilePayload(vectorFileRaw(payloadJson, `${what}.payload`))
  const magnitudesJson = payloadJson.magnitudes
  const storesHead = storageOf(json, what) === 'disk' || magnitudesJson !== undefined
  if (!storesHead) {
    const packed = await packChecksummedEnvelope(vectorPartChunks(payload), version, what)
    return { bytes: joined(packed.chunks) }
  }
  const magnitudes = new Float64Array(
    listAt(magnitudesJson, `${what}.payload.magnitudes`).map((value, at) =>
      numberFromJson(value, `${what}.payload.magnitudes[${at}]`),
    ),
  )
  const paged = pagedVectorFileChunks(payload, magnitudes)
  const packed = await packChecksummedEnvelope(paged.chunks, version, what)
  return {
    bytes: joined(packed.chunks),
    headOffset: paged.headOffset,
    headLength: paged.headLength,
    headChecksum: paged.headChecksum,
  }
}

function neighbourBytes(levels: Uint8Array, nodes: Json[], what: string): Uint8Array {
  const values: number[] = []
  let node = 0
  for (const level of levels) {
    if (level === 0) continue
    const layers = listAt(nodes[node], `${what}[${node}]`)
    if (layers.length !== level)
      throw new FormError(`${what}[${node}] holds ${layers.length} layers for level ${level}`)
    for (const [layer, list] of layers.entries()) {
      const ids = listAt(list, `${what}[${node}][${layer}]`)
      values.push(ids.length, ...ids.map((id, at) => numberFromJson(id, `${what}[${node}][${layer}][${at}]`)))
    }
    node += 1
  }
  if (node !== nodes.length) throw new FormError(`${what} holds ${nodes.length} nodes where levels give ${node}`)
  return numbersFromJson(values, 'uint32', what)
}

function graphRaw(graph: JsonObject, what: string): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(graph)) {
    if (key === 'levels' || key === 'neighbours') continue
    raw[key] = plainOf(untagged(value), `${what}.${key}`)
  }
  const levels = numbersFromJson(listAt(graph.levels, `${what}.levels`), 'uint8', `${what}.levels`)
  raw.levels = levels
  raw.neighbours = neighbourBytes(levels, listAt(graph.neighbours, `${what}.neighbours`), `${what}.neighbours`)
  return raw
}

export async function writeGraphPart(json: JsonObject, what: string): Promise<WrittenFile> {
  const payloadJson = objectAt(json.payload, `${what}.payload`)
  const raw: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payloadJson)) {
    const path = `${what}.payload.${key}`
    raw[key] =
      key === 'graphs'
        ? listAt(value, path).map((graph, at) => graphRaw(objectAt(graph, `${path}[${at}]`), `${path}[${at}]`))
        : plainOf(untagged(value), path)
  }
  const part = decodeVectorGraphPartPayload(raw)
  if (storageOf(json, what) === 'memory') {
    return { bytes: await packedEnvelope([encode(part)], headerFromJson(json.header, `${what} header`)) }
  }
  const paged = pagedGraphPartChunks(part)
  const packed = await packChecksummedEnvelope(paged.chunks, envelopeVersionOfCheckpointFile(json, what), what)
  return {
    bytes: joined(packed.chunks),
    headOffset: paged.headOffset,
    headLength: paged.headLength,
    headChecksum: paged.headChecksum,
  }
}
