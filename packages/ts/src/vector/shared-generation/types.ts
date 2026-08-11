import type { HNSWSnapshot } from '../hnsw'
import type { ScalarQuantizerCalibration } from '../scalar-quantization-types'

/**
 * Where each region of a frozen generation sits inside its shared memory.
 *
 * The memory opens with one float32 query scratch slot and one code query
 * scratch slot per worker, so concurrent searches never write over each
 * other, followed by the float32 vector arena and the quantised code arena.
 *
 * @internal
 */
export interface SharedGenerationLayout {
  /** Each vector carries this many components. */
  dimension: number
  /** The arenas span this many ordinals. */
  slots: number
  /** The memory holds this many per-worker scratch slot pairs. */
  workerSlots: number
  /** Each worker's float32 query scratch spans this many bytes. */
  float32ScratchStride: number
  /** Each worker's code query scratch spans this many bytes. */
  codeScratchStride: number
  /** The code query scratch slots start at this byte offset. */
  codeScratchOffset: number
  /** The float32 vector arena starts at this byte offset. */
  vectorsOffset: number
  /** The quantised code arena starts at this byte offset. */
  codesOffset: number
  /** The memory spans this many bytes, a whole number of pages. */
  totalBytes: number
}

/**
 * One frozen copy of a vector field, shared across every search thread.
 *
 * The typed arrays are views over shared buffers, so posting this to a worker
 * hands over the same bytes rather than a copy, and nothing in it is written
 * after the freeze apart from the per-worker scratch slots inside `memory`.
 *
 * @internal
 */
export interface SharedGenerationSnapshot {
  /** Each vector carries this many components. */
  dimension: number
  /** The workers compute quantised distances when this reads `sq8`. */
  quantization: 'sq8' | 'none'
  /** The constants every code was derived with, present when quantised. */
  calibration: ScalarQuantizerCalibration | null
  /** The shared memory holding the scratch slots and both arenas. */
  memory: WebAssembly.Memory
  /** Where each region sits inside the shared memory. */
  layout: SharedGenerationLayout
  /** Each ordinal's vector magnitude. */
  magnitudes: Float64Array
  /** Each ordinal's code sum, present when quantised. */
  codeSums: Float64Array
  /** Each ordinal's reconstructed code magnitude, present when quantised. */
  codeMagnitudes: Float64Array
  /** A byte per ordinal, 1 where codes exist, present when quantised. */
  codePresent: Uint8Array
  /** The built graph, its arrays backed by shared buffers. */
  graph: HNSWSnapshot
  /**
   * Each ordinal's document id rank in code point order, or
   * the absent-document rank where the ordinal holds no document.
   */
  rankByOrdinal: Uint32Array
}
