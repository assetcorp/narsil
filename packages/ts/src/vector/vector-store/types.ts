import type { VectorMetric } from '../brute-force'
import type { OrdinalFilter } from '../ordinal-filter'
import type { OsqBits } from '../osq/quantize'
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

export interface VectorSearchReader {
  readonly handles: SharedVectorStoreHandles
  entryForOrdinal(ordinal: number): VectorStoreEntry | undefined
  prepareQueryArena(query: Float32Array): ArenaQueryVector | null
  distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number
  queryDistance(prepared: ArenaQueryVector, metric: VectorMetric): (ordinal: number) => number
}

export interface VectorBuildReader extends VectorSearchReader {
  readonly dimension: number
  readonly slots: number
  holdsOrdinal(ordinal: number): boolean
  distanceByOrdinal(ordA: number, ordB: number, metric: VectorMetric): number
  ordinalDistance(from: number, metric: VectorMetric): (ordinal: number) => number
  pairDistance(metric: VectorMetric): (ordA: number, ordB: number) => number
}

export interface VectorStoreOptions {
  /** Every vector has this many components, and the first vector inserted sets it where the caller gives none. */
  dimension?: number
  /** Each level of a document code holds this many bits, and the store keeps no codes where the caller gives none. */
  codeBits?: OsqBits | null
  /** One float block may reach this many bytes, which a field kept on disk sets low so that the store releases a block soon after a checkpoint. */
  blockBytes?: number
}

export interface DiskLocation {
  fileIndex: number
  offset: number
}

export interface VectorStore extends VectorBuildReader {
  readonly size: number
  /** Each level of a document code holds this many bits, and null where the store keeps no codes. */
  readonly codeBits: OsqBits | null
  /** This reads true once every stored vector names the partition it belongs to. */
  readonly partitionsKnown: boolean
  /** Another thread opens these shared structures to read this store in place. */
  readonly handles: SharedVectorStoreHandles
  /** This thread reads the store through this view. */
  readonly view: SharedVectorStoreView
  /** Appends the vector at a fresh ordinal, retiring the ordinal the document held before, and returns the new one. */
  insert(docId: string, vector: Float32Array, partitionId?: number): number
  /** Appends a document whose vector a checkpoint file holds at a fresh ordinal, holding no block slot for it. */
  insertCold(docId: string, magnitude: number, location: DiskLocation, partitionId?: number): number
  /** Adds a checkpoint file the store reads released vectors from, and returns its index. */
  addVectorFile(path: string): number
  /** Reports whether a checkpoint file holds an ordinal's vector. */
  isCold(ordinal: number): boolean
  /** Points an ordinal at a file location and reports whether it did. A hot ordinal takes the location only once the file holds the same bytes. */
  releaseToFile(ordinal: number, location: DiskLocation): boolean
  /** Drops every block whose ordinals are all released or retired, and returns how many it dropped. */
  releaseColdBlocks(): number
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
  /**
   * Reports the bytes this store's shared structures hold, read from each
   * structure as it stands. The bookkeeping each thread keeps on its own heap
   * falls outside this figure, because no runtime call measures it.
   */
  memoryBytes(): number
  getOrdinal(docId: string): number | undefined
  docIdForOrdinal(ordinal: number): string | undefined
  exportSnapshot(): VectorStoreSnapshot
  restoreSnapshot(snapshot: VectorStoreSnapshot): void
}
