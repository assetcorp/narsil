import type { VectorMetric } from '../brute-force'
import type { OrdinalFilter } from '../ordinal-filter'
import type { SharedVectorStoreHandles } from './handles'
import type { SharedVectorStoreView } from './view'

export interface VectorStoreEntry {
  vector: Float32Array
  magnitude: number
}

export interface ArenaQueryVector {
  readonly magnitude: number
}

/**
 * The engine clones a field's vectors to another thread in this form, which
 * it uses where the runtime shares no memory between threads.
 *
 * @internal
 */
export interface VectorStoreSnapshot {
  /** Every vector of the field has this many components. */
  dimension: number
  /** The store spans this many ordinals, deleted ones included. */
  slots: number
  /** This holds every vector end to end, `slots * dimension` components long. */
  vectors: Float32Array
  /** This holds each ordinal's vector length, so a reader takes it from here. */
  magnitudes: Float64Array
  /** This names the document at each ordinal, and it reads `null` where the ordinal holds none. */
  docIds: Array<string | null>
}

/**
 * A nearest-neighbour search performs these reads against the stored vectors.
 *
 * The main thread's store and another thread's view over the same shared
 * blocks both satisfy it, so one search implementation serves both.
 *
 * @internal
 */
export interface VectorSearchReader {
  entryForOrdinal(ordinal: number): VectorStoreEntry | undefined
  prepareQueryArena(query: Float32Array): ArenaQueryVector | null
  distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number
}

/**
 * Graph construction performs these reads against the stored vectors, and the
 * main thread's store and a building thread's view both satisfy them.
 *
 * @internal
 */
export interface VectorBuildReader extends VectorSearchReader {
  readonly dimension: number
  readonly slots: number
  holdsOrdinal(ordinal: number): boolean
  distanceByOrdinal(ordA: number, ordB: number, metric: VectorMetric): number
}

export interface VectorStoreOptions {
  /** Every vector has this many components, and the first vector inserted sets it where the caller gives none. */
  dimension?: number
  /** Each slot reserves room for the vector's byte codes when this reads true, which is the default. */
  quantized?: boolean
}

export interface VectorStore extends VectorBuildReader {
  readonly size: number
  readonly quantized: boolean
  /** This reads true once every stored vector names the partition it belongs to. */
  readonly partitionsKnown: boolean
  /** Another thread opens these shared structures to read this store in place. */
  readonly handles: SharedVectorStoreHandles
  /** This thread reads the store through this view. */
  readonly view: SharedVectorStoreView
  /** Appends the vector at a fresh ordinal, retiring the ordinal the document held before, and returns the new one. */
  insert(docId: string, vector: Float32Array, partitionId?: number): number
  setPartition(docId: string, partitionId: number): void
  forgetPartition(docId: string): void
  partitionOfOrdinal(ordinal: number): number | undefined
  partitionFilter(partitionIds: ReadonlySet<number>): OrdinalFilter
  remove(docId: string): void
  get(docId: string): VectorStoreEntry | undefined
  has(docId: string): boolean
  entries(): IterableIterator<[string, VectorStoreEntry]>
  clear(): void
  /** Gives up the shared blocks, which the memory the vectors occupy returns with, and leaves an empty store behind. */
  release(): void
  estimateMemory(dimension: number): number
  getOrdinal(docId: string): number | undefined
  docIdForOrdinal(ordinal: number): string | undefined
  exportSnapshot(): VectorStoreSnapshot
  restoreSnapshot(snapshot: VectorStoreSnapshot): void
}
