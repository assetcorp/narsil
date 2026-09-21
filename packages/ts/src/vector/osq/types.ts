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
  /** Quantizes the stored vector of an ordinal and writes its record. */
  writeCodes(ordinal: number): void
}

export interface OsqQuantizer extends QuantizerBuildReader {
  readonly dimension: number
  /** The centroid the quantizer takes every record against, or null before calibration. */
  readonly centroid: Float32Array | null
  /** Computes the centroid from the stored vectors of the given ordinals and marks the field calibrated. */
  calibrate(ordinals: Int32Array): void
  /** Quantizes a document's stored vector and writes its record, after calibrating from that vector where the field holds no centroid. */
  quantize(docId: string): void
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
  /** Calibrates again over the stored vectors of the given ordinals and rewrites the record of each. */
  recalibrate(ordinals: Int32Array): void
  clear(): void
}
