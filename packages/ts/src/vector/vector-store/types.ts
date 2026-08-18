import type { VectorMetric } from '../brute-force'
import type { OrdinalFilter } from '../ordinal-filter'

export interface VectorStoreEntry {
  vector: Float32Array
  magnitude: number
}

export interface ArenaQueryVector {
  readonly magnitude: number
}

/**
 * Every stored vector in the form the engine hands to another thread.
 *
 * @internal
 */
export interface VectorStoreSnapshot {
  /** Each vector carries this many components. */
  dimension: number
  /** The store spans this many ordinals, deleted ones included. */
  slots: number
  /** This holds every vector end to end, `slots * dimension` components long. */
  vectors: Float32Array
  /** Each ordinal's vector length, so a reader need not recompute it. */
  magnitudes: Float64Array
  /** The document at each ordinal, `null` where the ordinal holds none. */
  docIds: Array<string | null>
}

/**
 * The reads a nearest-neighbour search performs against stored vectors.
 *
 * The main thread's mutable store and a worker's read-only view over shared
 * memory both satisfy this, which is what lets one search implementation run
 * on either side.
 *
 * @internal
 */
export interface VectorSearchReader {
  entryForOrdinal(ordinal: number): VectorStoreEntry | undefined
  prepareQueryArena(query: Float32Array): ArenaQueryVector | null
  distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number
}

export interface VectorStore extends VectorSearchReader {
  readonly size: number
  readonly slots: number
  /** False while any stored document is there without the partition it belongs to. */
  readonly partitionsKnown: boolean
  insert(docId: string, vector: Float32Array, partitionId?: number): void
  setPartition(docId: string, partitionId: number): void
  forgetPartition(docId: string): void
  partitionOfOrdinal(ordinal: number): number | undefined
  partitionFilter(partitionIds: ReadonlySet<number>): OrdinalFilter
  remove(docId: string): void
  get(docId: string): VectorStoreEntry | undefined
  has(docId: string): boolean
  entries(): IterableIterator<[string, VectorStoreEntry]>
  clear(): void
  estimateMemory(dimension: number): number
  getOrdinal(docId: string): number | undefined
  docIdForOrdinal(ordinal: number): string | undefined
  entryForOrdinal(ordinal: number): VectorStoreEntry | undefined
  distanceByOrdinal(ordA: number, ordB: number, metric: VectorMetric): number
  prepareQueryArena(query: Float32Array): ArenaQueryVector | null
  distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number
  exportSnapshot(): VectorStoreSnapshot
  restoreSnapshot(snapshot: VectorStoreSnapshot): void
  copySnapshotInto(vectors: Float32Array, magnitudes: Float64Array): void
}
