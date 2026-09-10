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

/**
 * A scalar quantizer turns a vector component into a byte with these two
 * constants, and it turns that byte back into a distance with them.
 *
 * Every thread reads these from the field's shared memory, so a thread that
 * places a vector in the graph derives the same codes the main thread would.
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
 * A nearest-neighbour search performs these reads against the quantised
 * codes.
 *
 * The main thread's quantizer and another thread's view over the same shared
 * codes both satisfy it, so one search implementation serves both.
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
  /** The quantizer derives every code from these constants, which stay absent until it calibrates. */
  readonly calibration: ScalarQuantizerCalibration | null
  readonly dimensions: number
  quantize(docId: string, vector: Float32Array): void
  remove(docId: string): void
  removeOrdinal(ordinal: number): void
  getQuantized(docId: string): Uint8Array | undefined
  calibrate(vectors: Iterable<Float32Array>): void
  needsRecalibration(vector: Float32Array): boolean
  recalibrateAll(vectors: Iterable<[string, Float32Array]>): void
  distanceFromPrepared(prepared: QuantizedQuery, docId: string, metric: VectorMetric): number
  hasOrdinal(ordinal: number): boolean
  serialize(): SerializedSQ8
  restoreCalibration(alpha: number, offset: number): void
  restoreEntry(docId: string, quantized: Uint8Array, sum: number, sumSq: number): void
  clear(): void
}
