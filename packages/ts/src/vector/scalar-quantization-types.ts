import type { VectorMetric } from './brute-force'

export interface SerializedSQ8 {
  alpha: number
  offset: number
  quantizedVectors: Record<string, number[]>
  vectorSums: Record<string, number>
  vectorSumSqs: Record<string, number>
}

export interface QuantizedQuery {
  quantized: Uint8Array
  sum: number
  sumSq: number
  magnitude: number
}

export interface ArenaQuery {
  sum: number
  sumSq: number
  magnitude: number
}

export interface OrdinalSource {
  getOrdinal(docId: string): number | undefined
}

/**
 * The two constants a scalar quantizer turns a vector component into a byte
 * with, and turns that byte back into a distance with.
 *
 * A worker holding a copy of a vector field receives these rather than deriving
 * its own, because a copy taken after a delete would otherwise measure a
 * narrower range of values and answer the same query differently from the
 * thread that built the index.
 *
 * @internal
 */
export interface ScalarQuantizerCalibration {
  /** Each step of the byte scale spans this much of the component range. */
  alpha: number
  /** The byte scale starts at this component value. */
  offset: number
}

/**
 * The reads a nearest-neighbour search performs against quantised codes.
 *
 * The main thread's mutable quantizer and a worker's read-only view over
 * shared memory both satisfy this, which is what lets one search
 * implementation run on either side.
 *
 * @internal
 */
export interface QuantizerSearchReader {
  readonly size: number
  isCalibrated(): boolean
  prepareQuery(query: Float32Array): QuantizedQuery | null
  distanceFromPreparedByOrdinal(prepared: QuantizedQuery, ordinal: number, metric: VectorMetric): number
  prepareQueryArena(query: Float32Array): ArenaQuery | null
  distanceFromArena(prepared: ArenaQuery, ordinal: number, metric: VectorMetric): number
}

export interface ScalarQuantizer extends QuantizerSearchReader {
  /** The constants every code is derived from, absent until calibration runs. */
  readonly calibration: ScalarQuantizerCalibration | null
  quantize(docId: string, vector: Float32Array): void
  remove(docId: string): void
  getQuantized(docId: string): Uint8Array | undefined
  calibrate(vectors: Iterable<Float32Array>): void
  needsRecalibration(vector: Float32Array): boolean
  recalibrateAll(vectors: Iterable<[string, Float32Array]>): void
  distanceFromPrepared(prepared: QuantizedQuery, docId: string, metric: VectorMetric): number
  hasOrdinal(ordinal: number): boolean
  readonly dimensions: number
  serialize(): SerializedSQ8
  restoreCalibration(alpha: number, offset: number): void
  restoreEntry(docId: string, quantized: Uint8Array, sum: number, sumSq: number): void
  copyStateInto(
    codes: Uint8Array,
    sums: Float64Array,
    sumSqs: Float64Array,
    magnitudes: Float64Array,
    present: Uint8Array,
  ): void
  clear(): void
}
