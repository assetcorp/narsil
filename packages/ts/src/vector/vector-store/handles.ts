import { MAX_DOC_ID_TABLE_BYTES, MAX_VECTOR_ORDINALS, VECTOR_STORE_INITIAL_CAPACITY } from '../constants'
import type { OsqBits } from '../osq/quantize'
import { createFixedBuffer, createGrowableBuffer, type GrowableBuffer } from '../shared-buffers/growable'
import {
  BLOCK_MAX_BYTES,
  blockBuffer,
  computeVectorBlockLayout,
  type VectorBlockHandle,
  type VectorBlockLayout,
} from './blocks'
import { computeCodeBlockLayout, type VectorCodeBlockLayout } from './code-blocks'

export const STORE_SLOTS = 0
export const STORE_LIVE_COUNT = 1
export const STORE_BLOCK_COUNT = 2
export const STORE_CALIBRATED = 3
export const STORE_CODE_COUNT = 4
export const STORE_DOC_ID_BYTES = 5
export const STORE_CODE_BLOCK_COUNT = 6
export const STORE_CALIBRATION_GENERATION = 7
export const STORE_RELEASED_VECTORS_TO_DISK = 8
const STORE_HEADER_WORDS = 16

export const IN_MEMORY = -1

/**
 * A thread opens these handles so that it can read one field's vectors,
 * codes, and document ids in place. They name the blocks holding the vectors,
 * the blocks holding the code records, the side tables that hold one entry
 * per ordinal, and the checkpoint files that hold the vectors of the
 * ordinals a field on disk has released from memory.
 *
 * The main thread appends ordinals, and because the tables grow in place, a
 * thread that opened the handles once goes on reading the current state.
 * Adding a block, releasing one, or adding a file is a structural change, so
 * the main thread bumps the layout revision and sends the handles again.
 *
 * @internal
 */
export interface SharedVectorStoreHandles {
  /** Every vector of the field has this many components. */
  dimension: number
  /** Each level of a document code holds this many bits, and null where the field keeps no codes. */
  codeBits: OsqBits | null
  /** Every float block of the field follows this layout. */
  layout: VectorBlockLayout
  /** Every code block of the field follows this layout, and null where the field keeps no codes. */
  codeLayout: VectorCodeBlockLayout | null
  /** The main thread raises this on every structural change, so a thread compares it against what it opened. */
  layoutRevision: number
  /** Every thread reads these counters through atomics. */
  header: Int32Array
  /** These blocks hold the vectors, in ordinal order, with null where the store released a block to disk or never filled it. */
  blocks: Array<VectorBlockHandle<VectorBlockLayout> | null>
  /** These blocks hold the code records, in ordinal order. */
  codeBlocks: VectorBlockHandle<VectorCodeBlockLayout>[]
  /** These are the paths of the checkpoint files holding vectors, with an empty string where no ordinal reads a file any more. */
  vectorFiles: string[]
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
  /** This holds one byte per ordinal, which reads 1 where the ordinal holds a code record. */
  codePresent: GrowableBuffer
  /** This holds the index into `vectorFiles` of the file holding each ordinal's vector, or -1 where a block holds it. */
  diskFile: GrowableBuffer
  /** This holds the byte offset of each ordinal's vector inside its file. */
  diskOffset: GrowableBuffer
  /** This holds the centroid the quantizer takes every code against. */
  centroid: Float32Array
}

function fixedInt32(words: number): Int32Array {
  return new Int32Array(createFixedBuffer(words * 4), 0, words)
}

function fixedFloat32(length: number): Float32Array {
  return new Float32Array(createFixedBuffer(length * 4), 0, length)
}

function perOrdinal(bytesPerOrdinal: number): GrowableBuffer {
  return createGrowableBuffer(
    VECTOR_STORE_INITIAL_CAPACITY * bytesPerOrdinal,
    (MAX_VECTOR_ORDINALS + 1) * bytesPerOrdinal,
  )
}

function inMemoryTable(): GrowableBuffer {
  const buffer = perOrdinal(4)
  new Int32Array(buffer).fill(IN_MEMORY)
  return buffer
}

export function createSharedVectorStoreHandles(
  dimension: number,
  codeBits: OsqBits | null,
  blockBytes: number = BLOCK_MAX_BYTES,
): SharedVectorStoreHandles {
  return {
    dimension,
    codeBits,
    layout: computeVectorBlockLayout(dimension, blockBytes),
    codeLayout: codeBits === null ? null : computeCodeBlockLayout(dimension, codeBits),
    layoutRevision: 0,
    header: fixedInt32(STORE_HEADER_WORDS),
    blocks: [],
    codeBlocks: [],
    vectorFiles: [],
    magnitudes: perOrdinal(8),
    present: perOrdinal(1),
    partitions: perOrdinal(4),
    docIdBytes: createGrowableBuffer(VECTOR_STORE_INITIAL_CAPACITY * 16, MAX_DOC_ID_TABLE_BYTES),
    docIdOffsets: perOrdinal(4),
    codePresent: perOrdinal(1),
    diskFile: inMemoryTable(),
    diskOffset: perOrdinal(4),
    centroid: fixedFloat32(dimension),
  }
}

export function sharedVectorStoreBytes(handles: SharedVectorStoreHandles): number {
  let bytes = handles.header.byteLength + handles.centroid.byteLength
  for (const block of handles.blocks) {
    if (block !== null) bytes += blockBuffer(block).byteLength
  }
  for (const block of handles.codeBlocks) bytes += blockBuffer(block).byteLength
  bytes += handles.magnitudes.byteLength
  bytes += handles.present.byteLength
  bytes += handles.partitions.byteLength
  bytes += handles.docIdBytes.byteLength
  bytes += handles.docIdOffsets.byteLength
  bytes += handles.codePresent.byteLength
  bytes += handles.diskFile.byteLength
  bytes += handles.diskOffset.byteLength
  return bytes
}
