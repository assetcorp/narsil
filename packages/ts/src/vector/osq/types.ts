import type { VectorMetric } from '../brute-force'
import type { OsqBits } from './quantize'
import type { OsqTrailer } from './record'

/**
 * This is a query quantised for the field's codes: its packed levels, ready
 * to stage beside the records a kernel reads, and its trailer.
 *
 * @internal
 */
export interface OsqQuery extends OsqTrailer {
  packed: Uint8Array
}

/**
 * A nearest-neighbour search performs these reads against the code records.
 *
 * The main thread's quantiser and another thread's view over the same shared
 * records both satisfy it, so one search implementation serves both.
 *
 * @internal
 */
export interface QuantizerSearchReader {
  readonly size: number
  readonly bits: OsqBits
  readonly metric: VectorMetric
  isCalibrated(): boolean
  prepareQuery(query: Float32Array): OsqQuery | null
  distanceFromPreparedByOrdinal(prepared: OsqQuery, ordinal: number): number
  distanceBetweenOrdinals(ordA: number, ordB: number): number
}

/**
 * A thread that places nodes in a graph writes each node's record through
 * this before it links the node, so every node the graph holds has a record
 * a later placement can score against.
 *
 * @internal
 */
export interface QuantizerBuildReader extends QuantizerSearchReader {
  writeCodes(ordinal: number, vector: Float32Array): void
}

/**
 * This is the main thread's quantiser over one field, which calibrates the
 * centroid, writes and clears records, and serves searches like any other
 * thread's view.
 *
 * @internal
 */
export interface OsqQuantizer extends QuantizerBuildReader {
  readonly dimension: number
  /** The centroid the quantiser takes every record against, or null before calibration. */
  readonly centroid: Float32Array | null
  /** Computes the centroid from the given vectors and marks the field calibrated. */
  calibrate(vectors: Iterable<Float32Array>): void
  /** Quantises a stored vector and writes its record. */
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
