import { ErrorCodes, NarsilError } from '../../errors'
import type { SerializedHNSWGraph } from '../hnsw'
import type { OsqBits } from '../osq'
import { osqRecordBytes } from '../osq/record'

export const VECTOR_INDEX_PAYLOAD_VERSION = 2
export const VECTOR_INDEX_PART_VECTORS = 65_536

/**
 * These are the code records of one part, with the centroid the quantiser
 * took them against.
 *
 * @internal
 */
export interface VectorIndexCodes {
  bits: OsqBits
  centroid: number[]
  records: Uint8Array
}

/**
 * This is one part of a vector field's persisted state, as the envelope
 * specification defines it: at most 65,536 vectors in ordinal order, the
 * graphs sliced to this part's nodes with their headers repeated, the code
 * records of these vectors, and the vectors themselves as little-endian
 * float32 written last so that a reader finds vector `i` at
 * `payload_length - (count - i) * dimension * 4`.
 *
 * @internal
 */
export interface VectorIndexPayload {
  v: typeof VECTOR_INDEX_PAYLOAD_VERSION
  fieldName: string
  dimension: number
  part: number
  parts: number
  docIds: string[]
  graphs: SerializedHNSWGraph[]
  codes: VectorIndexCodes | null
  vectors: Uint8Array
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

/**
 * Encodes vectors as the little-endian float32 bytes the payload carries.
 *
 * @internal
 */
export function vectorsToBytes(vectors: Float32Array): Uint8Array {
  if (LITTLE_ENDIAN) return new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength)
  const bytes = new Uint8Array(vectors.byteLength)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < vectors.length; i++) view.setFloat32(i * 4, vectors[i], true)
  return bytes
}

/**
 * Decodes the little-endian float32 bytes the payload carries.
 *
 * @internal
 */
export function bytesToVectors(bytes: Uint8Array): Float32Array {
  if (LITTLE_ENDIAN && bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  }
  const vectors = new Float32Array(bytes.byteLength / 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < vectors.length; i++) vectors[i] = view.getFloat32(i * 4, true)
  return vectors
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Invalid vector index payload: ${message}`, details)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isSerializedGraph(value: unknown): value is SerializedHNSWGraph {
  return isRecord(value) && Array.isArray(value.nodes)
}

function codesOf(raw: unknown, dimension: number, count: number): VectorIndexCodes | null {
  if (raw === null || raw === undefined) return null
  if (!isRecord(raw)) invalid('codes must be a map or nil')
  const bits = raw.bits
  if (bits !== 1 && bits !== 2 && bits !== 4 && bits !== 8) invalid('codes.bits must be 8, 4, 2, or 1', { bits })
  if (!Array.isArray(raw.centroid) || raw.centroid.length !== dimension) {
    invalid('codes.centroid must hold one number per dimension')
  }
  if (!(raw.records instanceof Uint8Array)) invalid('codes.records must be bytes')
  if (raw.records.byteLength !== count * osqRecordBytes(dimension, bits)) {
    invalid('codes.records must hold one record per vector', { count, bytes: raw.records.byteLength })
  }
  return { bits, centroid: raw.centroid.map(Number), records: raw.records }
}

/**
 * Validates one decoded part and returns it typed. It rejects a payload
 * written in the earlier layout, which carries no version, with
 * `ENVELOPE_VERSION_MISMATCH`, as the compatibility rules require before 1.0.
 *
 * @internal
 */
export function decodeVectorIndexPart(raw: unknown): VectorIndexPayload {
  if (!isRecord(raw)) invalid('payload must be a map')
  if (raw.v !== VECTOR_INDEX_PAYLOAD_VERSION) {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      `This vector index payload was written in layout ${String(raw.v ?? 1)}, and this build reads layout ${VECTOR_INDEX_PAYLOAD_VERSION} alone`,
      { version: raw.v ?? 1 },
    )
  }
  if (typeof raw.fieldName !== 'string') invalid('fieldName must be a string')
  if (!isNonNegativeInteger(raw.dimension) || raw.dimension === 0) invalid('dimension must be a positive integer')
  if (!isNonNegativeInteger(raw.part)) invalid('part must be a non-negative integer')
  if (!isNonNegativeInteger(raw.parts) || raw.parts === 0 || raw.part >= raw.parts) {
    invalid('parts must exceed part', { part: raw.part, parts: raw.parts })
  }
  if (!Array.isArray(raw.docIds) || !raw.docIds.every(docId => typeof docId === 'string')) {
    invalid('docIds must be a list of strings')
  }
  if (raw.docIds.length > VECTOR_INDEX_PART_VECTORS) {
    invalid(`a part holds at most ${VECTOR_INDEX_PART_VECTORS} vectors`, { count: raw.docIds.length })
  }
  if (!Array.isArray(raw.graphs) || !raw.graphs.every(isSerializedGraph)) {
    invalid('graphs must be a list of graphs, each holding a list of nodes')
  }
  if (!(raw.vectors instanceof Uint8Array)) invalid('vectors must be bytes')
  if (raw.vectors.byteLength !== raw.docIds.length * raw.dimension * 4) {
    invalid('vectors must hold dimension float32 components per document', {
      count: raw.docIds.length,
      bytes: raw.vectors.byteLength,
    })
  }
  return {
    v: VECTOR_INDEX_PAYLOAD_VERSION,
    fieldName: raw.fieldName,
    dimension: raw.dimension,
    part: raw.part,
    parts: raw.parts,
    docIds: raw.docIds,
    graphs: raw.graphs,
    codes: codesOf(raw.codes, raw.dimension, raw.docIds.length),
    vectors: raw.vectors,
  }
}

/**
 * Validates a list of parts, which a snapshot bundle or an index snapshot
 * carries per field.
 *
 * @internal
 */
export function decodeVectorIndexParts(raw: unknown): VectorIndexPayload[] {
  if (!Array.isArray(raw)) invalid('a field must carry a list of parts')
  return raw.map(decodeVectorIndexPart)
}
