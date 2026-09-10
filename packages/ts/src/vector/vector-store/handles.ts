import { MAX_DOC_ID_TABLE_BYTES, MAX_VECTOR_ORDINALS, VECTOR_STORE_INITIAL_CAPACITY } from '../constants'
import { createGrowableBuffer, type GrowableBuffer } from '../shared-buffers/growable'
import { computeVectorBlockLayout, type VectorBlockHandle, type VectorBlockLayout } from './blocks'

export const STORE_SLOTS = 0
export const STORE_LIVE_COUNT = 1
export const STORE_BLOCK_COUNT = 2
export const STORE_CALIBRATED = 3
export const STORE_CODE_COUNT = 4
export const STORE_DOC_ID_BYTES = 5
const STORE_HEADER_WORDS = 8

export const CALIBRATION_ALPHA = 0
export const CALIBRATION_OFFSET = 1
const CALIBRATION_WORDS = 2

/**
 * A thread opens these handles so that it can read one field's vectors,
 * codes, and document ids in place. They name the blocks holding the vectors
 * and the side tables that hold one entry per ordinal, and every one of those
 * structures grows without moving.
 *
 * The main thread appends ordinals, and because the tables grow in place, a
 * thread that opened the handles once goes on reading the current state.
 * Adding a block is the one structural change, so the main thread sends the
 * handles again whenever it adds one.
 *
 * @internal
 */
export interface SharedVectorStoreHandles {
  /** Every vector of the field has this many components. */
  dimension: number
  /** Each slot also holds the vector's byte codes when this reads true. */
  quantized: boolean
  /** Every block of the field follows this layout. */
  layout: VectorBlockLayout
  /** Every thread reads these counters through atomics. */
  header: Int32Array
  /** These blocks hold the vectors, in ordinal order. */
  blocks: VectorBlockHandle[]
  /** This holds each ordinal's vector magnitude. */
  magnitudes: GrowableBuffer
  /** This holds one byte per ordinal, which reads 1 where the ordinal holds a live vector. */
  present: GrowableBuffer
  /** This holds each ordinal's partition, or a negative marker where the store knows none. */
  partitions: GrowableBuffer
  /** This holds every document id, UTF-8 encoded end to end in ordinal order. */
  docIdBytes: GrowableBuffer
  /** This holds the byte each ordinal's id starts at, with one closing offset after the last. */
  docIdOffsets: GrowableBuffer
  /** This holds each ordinal's code sum. */
  codeSums: GrowableBuffer
  /** This holds each ordinal's squared code sum. */
  codeSumSqs: GrowableBuffer
  /** This holds the magnitude each ordinal's codes decode to. */
  codeMagnitudes: GrowableBuffer
  /** This holds one byte per ordinal, which reads 1 where the ordinal holds codes. */
  codePresent: GrowableBuffer
  /** This holds the quantiser's alpha and offset. */
  calibration: Float64Array
}

function sharedInt32(words: number): Int32Array {
  return new Int32Array(createGrowableBuffer(words * 4, words * 4))
}

function sharedFloat64(words: number): Float64Array {
  return new Float64Array(createGrowableBuffer(words * 8, words * 8))
}

function perOrdinal(bytesPerOrdinal: number): GrowableBuffer {
  return createGrowableBuffer(
    VECTOR_STORE_INITIAL_CAPACITY * bytesPerOrdinal,
    (MAX_VECTOR_ORDINALS + 1) * bytesPerOrdinal,
  )
}

/**
 * Allocates the handles of an empty field.
 *
 * @param dimension The number of components per vector.
 * @param quantized Whether each slot also holds byte codes.
 * @returns The handles, holding no block yet.
 *
 * @internal
 */
export function createSharedVectorStoreHandles(dimension: number, quantized: boolean): SharedVectorStoreHandles {
  return {
    dimension,
    quantized,
    layout: computeVectorBlockLayout(dimension, quantized),
    header: sharedInt32(STORE_HEADER_WORDS),
    blocks: [],
    magnitudes: perOrdinal(8),
    present: perOrdinal(1),
    partitions: perOrdinal(4),
    docIdBytes: createGrowableBuffer(VECTOR_STORE_INITIAL_CAPACITY * 16, MAX_DOC_ID_TABLE_BYTES),
    docIdOffsets: perOrdinal(4),
    codeSums: perOrdinal(8),
    codeSumSqs: perOrdinal(8),
    codeMagnitudes: perOrdinal(8),
    codePresent: perOrdinal(1),
    calibration: sharedFloat64(CALIBRATION_WORDS),
  }
}
