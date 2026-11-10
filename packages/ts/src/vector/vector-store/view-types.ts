import type { VectorMetric } from '../brute-force'
import type { OpenVectorBlock } from './blocks'
import type { SharedVectorStoreHandles } from './handles'
import type { HotBlockReads } from './hot-block-distance'
import type { ArenaQueryVector, VectorStoreEntry } from './types'

export interface SharedVectorStoreView {
  readonly dimension: number
  readonly threadSlot: number
  readonly handles: SharedVectorStoreHandles
  readonly slots: number
  readonly simdAvailable: boolean
  /** Reports whether this thread has opened every block the field holds, which reads false until the main thread sends the handles of a block it has added. */
  readonly holdsEveryBlock: boolean
  adoptHandles(handles: SharedVectorStoreHandles): void
  /** Rebuilds the views over the side tables once the main thread has grown them. */
  rebind(): void
  holdsOrdinal(ordinal: number): boolean
  /** Reports whether a checkpoint file holds an ordinal's vector. */
  isCold(ordinal: number): boolean
  entryForOrdinal(ordinal: number): VectorStoreEntry | undefined
  /** Reads an ordinal's vector, which for a released ordinal is a fresh copy read from its file. */
  vectorAt(ordinal: number): Float32Array
  magnitudeAt(ordinal: number): number
  docIdAt(ordinal: number): string | undefined
  partitionAt(ordinal: number): number | undefined
  distanceByOrdinal(ordA: number, ordB: number, metric: VectorMetric): number
  prepareQueryArena(query: Float32Array): ArenaQueryVector | null
  distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number
  distanceFromQuery(query: Float32Array, queryMagnitude: number, ordinal: number, metric: VectorMetric): number
  hotBlockReads(): HotBlockReads | null
  queryDistance(prepared: ArenaQueryVector, metric: VectorMetric): (ordinal: number) => number
  ordinalDistance(from: number, metric: VectorMetric): (ordinal: number) => number
  pairDistance(metric: VectorMetric): (ordA: number, ordB: number) => number
  blockOf(ordinal: number): OpenVectorBlock
  localOrdinal(ordinal: number): number
  /** Opens the code block holding an ordinal's record, which every code block of the field must exist for. */
  codeBlockOf(ordinal: number): OpenVectorBlock
  codeLocalOrdinal(ordinal: number): number
  /** Reports the code blocks this thread has opened, so a query can reset what it staged in each. */
  openCodeBlocks(): Iterable<OpenVectorBlock>
  /** Reads a released ordinal's vector from its file into the given target, and reports false where the file is gone. */
  readColdInto(ordinal: number, target: Float32Array): boolean
  /** Reads a vector at a byte offset of one of the store's files into the target, and reports false where the file is gone. */
  readFromFile(fileIndex: number, offset: number, target: Float32Array): boolean
  /** Closes every file descriptor this thread opened for released vectors. */
  close(): void
}
