import { VECTOR_SCRATCH_SLOTS } from '../constants'
import { osqQueryBits } from '../osq/estimate'
import type { OsqBits } from '../osq/quantize'
import { osqCodeBytes, osqRecordBytes, osqStagedQueryBytes } from '../osq/record'
import { alignUp, BLOCK_MAX_BYTES, type BlockGeometry } from './blocks'

/**
 * This is the geometry of a block holding one code record per slot: the packed code
 * with its lower, upper, correction, and sum inline, so a comparison reads
 * one contiguous record. Each thread's scratch holds one staged query.
 *
 * @internal
 */
export interface VectorCodeBlockLayout extends BlockGeometry {
  /** Every vector of the field has this many components. */
  dimension: number
  /** Each level of a document code holds this many bits. */
  bits: OsqBits
  /** Each level of a query code holds this many bits. */
  queryBits: OsqBits
  /** A packed document code spans this many bytes. */
  codeBytes: number
  /** A staged query spans this many bytes. */
  queryBytes: number
}

export function computeCodeBlockLayout(dimension: number, bits: OsqBits): VectorCodeBlockLayout {
  const queryBits = osqQueryBits(bits)
  const codeBytes = osqCodeBytes(dimension, bits)
  const queryBytes = osqStagedQueryBytes(dimension, bits)
  const scratchStride = alignUp(queryBytes)
  const slotsOffset = alignUp(VECTOR_SCRATCH_SLOTS * scratchStride)
  const slotStride = osqRecordBytes(dimension, bits)
  return {
    dimension,
    bits,
    queryBits,
    codeBytes,
    queryBytes,
    scratchStride,
    slotsOffset,
    slotStride,
    capacity: Math.floor((BLOCK_MAX_BYTES - slotsOffset) / slotStride),
  }
}
