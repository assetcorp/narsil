import type { VectorMetric } from '../brute-force'
import { createHNSWIndex, type HNSWConfig, type HNSWIndex, type SerializedHNSWGraph } from '../hnsw'
import { addToOrdinalFilter, createOrdinalFilter, type OrdinalFilter, removeFromOrdinalFilter } from '../ordinal-filter'
import type { ScalarQuantizer, SerializedSQ8 } from '../scalar-quantization-types'
import type { VectorSearchPool } from '../search-pool'
import type { VectorStore } from '../vector-store'

export const DEFAULT_PROMOTION_THRESHOLD = 1024
export const DEFAULT_FILTER_THRESHOLD = 0.03
export const ESTIMATED_MS_PER_TOMBSTONE = 0.05
export const ESTIMATED_MS_PER_VECTOR_REBUILD = 0.15
export const WORKER_BUILD_SIZE_THRESHOLD = 5000
export const WORKER_COPY_MIN_VECTORS = 1024
const BUILD_CHUNK_SIZE = 100
const REBUILD_REMOVED_RATIO = 0.2

export interface VectorScoredResult {
  docId: string
  score: number
}

export interface VectorSearchOptions {
  metric: VectorMetric
  minSimilarity: number
  filterDocIds?: Set<string>
  /** The partitions the search may answer from, which the index resolves to ordinals itself. */
  filterPartitions?: ReadonlySet<number>
  efSearch?: number
}

export interface VectorWorkerCopyPolicy {
  /** Whether the index may load copies of its graph onto the vector search pool. */
  enabled: boolean
  /** The pool runs this many workers, or the host's cores minus one where omitted. */
  count?: number
}

export const VECTOR_WORKER_COPIES_ALLOWED: VectorWorkerCopyPolicy = { enabled: true }

export interface MaintenanceStatus {
  tombstoneRatio: number
  graphCount: number
  bufferSize: number
  building: boolean
  estimatedCompactMs: number
  estimatedOptimizeMs: number
}

export interface VectorIndexPayload {
  fieldName: string
  dimension: number
  vectors: Array<{ docId: string; vector: number[] }>
  graphs: Array<SerializedHNSWGraph>
  sq8: SerializedSQ8 | null
}

export interface VectorIndexState {
  readonly fieldName: string
  readonly dimension: number
  readonly dimensionScale: number
  readonly promotionThreshold: number
  readonly filterThreshold: number
  readonly quantizationMode: 'sq8' | 'none'
  readonly hnswConfig: HNSWConfig | undefined
  readonly workerCopies: VectorWorkerCopyPolicy
  readonly store: VectorStore
  readonly tombstones: Set<string>
  readonly buffer: Set<string>
  sq8: ScalarQuantizer | null
  hnsw: HNSWIndex | null
  compactedNodeCount: number
  building: boolean
  buildScheduled: boolean
  pendingBuild: Promise<void> | null
  disposed: boolean
  revision: number
  workerCopyPool: VectorSearchPool | null
  workerCopyHandle: string | null
  workerCopyRevision: number
  workerCopyMode: 'shared' | 'clone' | null
  workerCopyLoading: boolean
}

export function liveSize(state: VectorIndexState): number {
  return state.store.size - state.tombstones.size
}

/**
 * Makes a graph built from every live vector the one the index answers from,
 * or clears the graph away where none is given.
 *
 * The new graph takes a tombstone for every document a caller removed while
 * it was being built, and the count of nodes that compaction cut out of the
 * graph before it starts again from zero.
 *
 * @param state The index to update.
 * @param graph The graph to adopt, or null where the index keeps no graph.
 *
 * @internal
 */
export function adoptGraph(state: VectorIndexState, graph: HNSWIndex | null): void {
  if (graph === null && state.hnsw !== null) {
    state.hnsw.clear()
  }
  state.hnsw = graph
  state.compactedNodeCount = 0

  if (graph === null) return
  for (const docId of state.tombstones) {
    if (graph.has(docId)) {
      graph.markTombstone(docId)
    }
  }
}

/**
 * Inserts the admitted documents into a graph, yielding to the event loop
 * after every chunk so that a query can answer between chunks.
 *
 * The insertion clears each document's buffer marker the moment the graph
 * links its stored vector, so a vector that a caller replaces during a later
 * chunk keeps its marker and the next build relinks it.
 *
 * @param state The index the graph belongs to, whose disposal stops the work.
 * @param graph The graph to insert into.
 * @param docIds The documents to offer.
 * @param admit Reports whether a document goes into the graph.
 * @param inserted Runs after each document goes in, where given.
 * @returns True where every document was offered, and false where disposal
 * stopped the work first.
 *
 * @internal
 */
export async function insertIntoGraph(
  state: VectorIndexState,
  graph: HNSWIndex,
  docIds: Iterable<string>,
  admit: (docId: string) => boolean,
  inserted?: (docId: string) => void,
): Promise<boolean> {
  let count = 0
  for (const docId of docIds) {
    if (state.disposed) return false
    if (!admit(docId)) continue
    graph.insertNode(docId)
    state.buffer.delete(docId)
    inserted?.(docId)
    count += 1
    if (count % BUILD_CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }
  return !state.disposed
}

/**
 * Builds a graph from every live vector in the store and makes it the graph
 * the index answers from once every vector is in.
 *
 * @param state The index to build for, whose disposal drops the new graph.
 *
 * @internal
 */
export async function buildGraphFromStore(state: VectorIndexState): Promise<void> {
  const graph = createHNSWIndex(state.dimension, state.store, state.hnswConfig, state.sq8 ?? undefined)
  const completed = await insertIntoGraph(state, graph, allLiveDocIds(state), () => true)
  if (completed) {
    adoptGraph(state, graph)
  }
}

/**
 * Reports whether callers have removed more than a fifth of the vectors the
 * graph has held since it was last built, which is the point at which the
 * vector index specification requires a rebuild.
 *
 * The removed vectors are the nodes the graph still holds as tombstones plus
 * the nodes compaction has cut out since the last rebuild, and the vectors
 * held are those removed nodes plus the live ones.
 *
 * @param state The index to read.
 * @returns True once the removals pass that fraction.
 *
 * @internal
 */
export function graphNeedsRebuild(state: VectorIndexState): boolean {
  const graph = state.hnsw
  if (graph === null) return false
  const removed = graph.tombstoneCount + state.compactedNodeCount
  const held = graph.size + removed
  if (held === 0) return false
  return removed / held > REBUILD_REMOVED_RATIO
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

export function* allLiveDocIds(state: VectorIndexState): Iterable<string> {
  for (const [docId] of state.store.entries()) {
    if (state.tombstones.has(docId)) continue
    yield docId
  }
}

/**
 * Builds the filter holding every live ordinal of the named partitions.
 *
 * The store keeps each vector's partition, so this walks ordinals rather than
 * document ids, and it clears the removed documents the index has yet to
 * compact away.
 *
 * @param state The index to read.
 * @param partitionIds The partitions the caller may see.
 * @returns The ordinals of those partitions.
 *
 * @internal
 */
export function ordinalFilterForPartitions(state: VectorIndexState, partitionIds: ReadonlySet<number>): OrdinalFilter {
  const filter = state.store.partitionFilter(partitionIds)
  for (const docId of state.tombstones) {
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal === undefined) continue
    removeFromOrdinalFilter(filter, ordinal)
  }
  return filter
}

/**
 * Builds the ordinal filter a search must respect, from whichever confinement
 * the caller gave.
 *
 * @param state The index to read.
 * @param options The search options carrying the confinement.
 * @returns The ordinals the search may return, or undefined where the caller
 * confined nothing.
 *
 * @internal
 */
export function filterForOptions(
  state: VectorIndexState,
  options: { filterDocIds?: Set<string>; filterPartitions?: ReadonlySet<number> },
): OrdinalFilter | undefined {
  if (options.filterDocIds !== undefined) {
    return ordinalFilterForDocIds(state, options.filterDocIds)
  }
  if (options.filterPartitions !== undefined) {
    return ordinalFilterForPartitions(state, options.filterPartitions)
  }
  return undefined
}

export function ordinalFilterForDocIds(state: VectorIndexState, docIds: Iterable<string>): OrdinalFilter {
  const filter = createOrdinalFilter(state.store.slots)
  for (const docId of docIds) {
    if (state.tombstones.has(docId)) continue
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal === undefined) continue
    addToOrdinalFilter(filter, ordinal)
  }
  return filter
}

export function calibrateAndQuantizeAll(state: VectorIndexState): void {
  if (!state.sq8) return
  if (state.store.size === 0) return

  const sq8 = state.sq8

  function* vectorIterator(): Iterable<Float32Array> {
    for (const [docId, entry] of state.store.entries()) {
      if (state.tombstones.has(docId)) continue
      yield entry.vector
    }
  }

  sq8.calibrate(vectorIterator())

  for (const [docId, entry] of state.store.entries()) {
    if (state.tombstones.has(docId)) continue
    sq8.quantize(docId, entry.vector)
  }
}

export function recalibrateFromStore(state: VectorIndexState): void {
  if (!state.sq8) return
  const sq8 = state.sq8

  function* storeVectors(): Iterable<[string, Float32Array]> {
    for (const [docId, entry] of state.store.entries()) {
      if (state.tombstones.has(docId)) continue
      yield [docId, entry.vector]
    }
  }
  sq8.recalibrateAll(storeVectors())
}
