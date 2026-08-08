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

export interface ScalarQuantizer {
  /** The constants every code is derived from, absent until calibration runs. */
  readonly calibration: ScalarQuantizerCalibration | null
  quantize(docId: string, vector: Float32Array): void
  remove(docId: string): void
  getQuantized(docId: string): Uint8Array | undefined
  isCalibrated(): boolean
  calibrate(vectors: Iterable<Float32Array>): void
  needsRecalibration(vector: Float32Array): boolean
  recalibrateAll(vectors: Iterable<[string, Float32Array]>): void
  prepareQuery(query: Float32Array): QuantizedQuery | null
  distanceFromPrepared(prepared: QuantizedQuery, docId: string, metric: VectorMetric): number
  distanceFromPreparedByOrdinal(prepared: QuantizedQuery, ordinal: number, metric: VectorMetric): number
  prepareQueryArena(query: Float32Array): ArenaQuery | null
  distanceFromArena(prepared: ArenaQuery, ordinal: number, metric: VectorMetric): number
  hasOrdinal(ordinal: number): boolean
  readonly dimensions: number
  readonly size: number
  serialize(): SerializedSQ8
  restoreCalibration(alpha: number, offset: number): void
  restoreEntry(docId: string, quantized: Uint8Array, sum: number, sumSq: number): void
  clear(): void
}
