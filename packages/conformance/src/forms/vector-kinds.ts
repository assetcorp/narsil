import type { FormContext } from './codec'
import { type Decoded, FormError, fieldOf, listOf, mapOf, numberOf } from './decoded'
import { headerJson } from './header'
import { type Json, type JsonObject, tagged, taggedNumber } from './json'
import { numbersJson, numbersOf } from './numbers'

export type VectorStorage = 'memory' | 'disk'

const OSQ_RECORD_TAIL_BYTES = 16
const BITS_PER_BYTE = 8
const FLOAT32_BYTES = 4
const VECTOR_FILE_PLACEMENT_KEYS = new Set(['idOffsets', 'head'])
const DISK_VECTOR_FILE_KEYS = ['magnitudes', 'idOffsets', 'idOrder', 'head']
const GRAPH_BYTE_KEYS = new Set(['levels', 'neighbours'])

function bytesField(map: Map<string, Decoded>, key: string, what: string): Uint8Array {
  const value = fieldOf(map, key, what)
  if (!(value instanceof Uint8Array)) throw new FormError(`${what}.${key} is not a binary value`)
  return value
}

function recordsJson(records: Uint8Array, dimension: number, bits: number, count: number, what: string): Json[] {
  const codeBytes = Math.ceil((dimension * bits) / BITS_PER_BYTE)
  const recordBytes = codeBytes + OSQ_RECORD_TAIL_BYTES
  if (records.byteLength !== recordBytes * count) {
    throw new FormError(`${what} holds ${records.byteLength} bytes for ${count} records of ${recordBytes} bytes`)
  }
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength)
  const list: Json[] = []
  for (let at = 0; at < count; at++) {
    const start = at * recordBytes
    const tail = start + codeBytes
    list.push({
      code: Array.from(records.subarray(start, tail)),
      lower: taggedNumber(view.getFloat32(tail, true)),
      upper: taggedNumber(view.getFloat32(tail + 4, true)),
      correction: taggedNumber(view.getFloat32(tail + 8, true)),
      sum: view.getUint32(tail + 12, true),
    })
  }
  return list
}

function codesJson(value: Decoded, dimension: number, count: number, what: string): Json {
  if (value === null) return null
  const codes = mapOf(value, what)
  const bits = numberOf(fieldOf(codes, 'bits', what), `${what}.bits`)
  const object: JsonObject = {}
  for (const [key, entry] of codes) {
    object[key] =
      key === 'records'
        ? recordsJson(bytesField(codes, 'records', what), dimension, bits, count, `${what}.records`)
        : tagged(entry)
  }
  return object
}

function vectorsJson(vectors: Uint8Array, dimension: number, count: number, what: string): Json[] {
  if (vectors.byteLength !== count * dimension * FLOAT32_BYTES) {
    throw new FormError(`${what} holds ${vectors.byteLength} bytes for ${count} vectors of ${dimension} components`)
  }
  const components = numbersJson(vectors, 'float32', what)
  const list: Json[] = []
  for (let at = 0; at < count; at++) list.push(components.slice(at * dimension, (at + 1) * dimension))
  return list
}

function requireDiskKeys(map: Map<string, Decoded>, keys: readonly string[], storage: VectorStorage, what: string) {
  if (storage !== 'disk') return
  for (const key of keys) {
    if (!map.has(key)) throw new FormError(`${what} belongs to a disk field and holds no ${key}`)
  }
}

export async function vectorFileJson(
  bytes: Uint8Array,
  storage: VectorStorage,
  context: FormContext,
  what: string,
): Promise<JsonObject> {
  const { header, payload } = await context.openEnvelope(bytes, what)
  const map = mapOf(context.unpack(payload, what), `${what} payload`)
  const keys = [...map.keys()]
  if (keys[keys.length - 1] !== 'vectors') throw new FormError(`${what} holds ${keys.at(-1)} after vectors`)
  requireDiskKeys(map, DISK_VECTOR_FILE_KEYS, storage, what)
  const dimension = numberOf(fieldOf(map, 'dimension', what), `${what}.dimension`)
  const count = listOf(fieldOf(map, 'docIds', what), `${what}.docIds`).length
  const object: JsonObject = {}
  for (const [key, value] of map) {
    const path = `${what}.${key}`
    if (VECTOR_FILE_PLACEMENT_KEYS.has(key)) continue
    if (key === 'codes') object[key] = codesJson(value, dimension, count, path)
    else if (key === 'magnitudes') object[key] = numbersJson(bytesField(map, key, what), 'float64', path)
    else if (key === 'idOrder') object[key] = numbersJson(bytesField(map, key, what), 'uint32', path)
    else if (key === 'vectors') object[key] = vectorsJson(bytesField(map, key, what), dimension, count, path)
    else object[key] = tagged(value)
  }
  return { header: headerJson(header), storage, payload: object }
}

function neighboursJson(levels: Uint8Array, neighbours: Uint8Array, what: string): Json[] {
  const values = numbersOf(neighbours, 'uint32', what)
  const nodes: Json[] = []
  let cursor = 0
  for (const level of levels) {
    if (level === 0) continue
    const layers: Json[] = []
    for (let layer = 0; layer < level; layer++) {
      if (cursor >= values.length) throw new FormError(`${what} ends before a node's layer ${layer}`)
      const count = values[cursor]
      if (cursor + 1 + count > values.length) throw new FormError(`${what} ends inside a list`)
      layers.push(values.slice(cursor + 1, cursor + 1 + count))
      cursor += 1 + count
    }
    nodes.push(layers)
  }
  if (cursor !== values.length) throw new FormError(`${what} holds values after the last node's lists`)
  return nodes
}

function graphJson(value: Decoded, what: string): JsonObject {
  const graph = mapOf(value, what)
  const levels = bytesField(graph, 'levels', what)
  const object: JsonObject = {}
  for (const [key, entry] of graph) {
    if (GRAPH_BYTE_KEYS.has(key)) continue
    object[key] = tagged(entry)
  }
  object.levels = Array.from(levels)
  object.neighbours = neighboursJson(levels, bytesField(graph, 'neighbours', what), `${what}.neighbours`)
  return object
}

export async function graphPartJson(
  bytes: Uint8Array,
  storage: VectorStorage,
  context: FormContext,
  what: string,
): Promise<JsonObject> {
  const { header, payload } = await context.openEnvelope(bytes, what)
  const map = mapOf(context.unpack(payload, what), `${what} payload`)
  requireDiskKeys(map, ['head'], storage, what)
  const object: JsonObject = {}
  for (const [key, value] of map) {
    if (key === 'head') continue
    const path = `${what}.${key}`
    object[key] =
      key === 'graphs' ? listOf(value, path).map((graph, at) => graphJson(graph, `${path}[${at}]`)) : tagged(value)
  }
  return { header: headerJson(header), storage, payload: object }
}
