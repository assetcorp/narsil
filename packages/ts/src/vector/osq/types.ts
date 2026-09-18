import type { VectorMetric } from '../brute-force'
import type { OsqBits } from './quantize'
import type { OsqTrailer } from './record'

export interface OsqQuery extends OsqTrailer {
  packed: Uint8Array
}

export interface QuantizerSearchReader {
  readonly size: number
  readonly bits: OsqBits
  readonly metric: VectorMetric
  isCalibrated(): boolean
  prepareQuery(query: Float32Array): OsqQuery | null
  distanceFromPreparedByOrdinal(prepared: OsqQuery, ordinal: number): number
  preparedDistance(prepared: OsqQuery): (ordinal: number) => number
  pairDistance(): (ordA: number, ordB: number) => number
  distanceBetweenOrdinals(ordA: number, ordB: number): number
}

export interface QuantizerBuildReader extends QuantizerSearchReader {
  writeCodes(ordinal: number, vector: Float32Array): void
}

export interface OsqQuantizer extends QuantizerBuildReader {
  readonly dimension: number
  /** The centroid the quantizer takes every record against, or null before calibration. */
  readonly centroid: Float32Array | null
  /** Computes the centroid from the given vectors and marks the field calibrated. */
  calibrate(vectors: Iterable<Float32Array>): void
  /** Quantizes a stored vector and writes its record. */
  quantize(docId: string, vector: Float32Array): void
  remove(docId: string): void
  removeOrdinal(ordinal: number): void
  hasOrdinal(ordinal: number): boolean
  /** Reads the levels of a document's record, or undefined where it holds none. */
  getLevels(docId: string): Uint8Array | undefined
  /** Reads a document's record in place, or undefined where it holds none. */
  recordOf(docId: string): Uint8Array | undefined
  /** Copies a record written elsewhere into a stored document's slot. */
  restoreRecord(docId: string, record: Uint8Array): void
  restoreCentroid(centroid: Float32Array): void
  /** Calibrates again over the given vectors and rewrites every record from them. */
  recalibrateAll(vectors: Iterable<[string, Float32Array]>): void
  clear(): void
}
