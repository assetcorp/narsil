import type { VectorMetric } from '../brute-force'
import type { HNSWConfig, HNSWIndex, SerializedHNSWGraph } from '../hnsw'
import { addToOrdinalFilter, createOrdinalFilter, type OrdinalFilter, removeFromOrdinalFilter } from '../ordinal-filter'
import type { ScalarQuantizer, SerializedSQ8 } from '../scalar-quantization-types'
import type { VectorSearchPool } from '../search-pool'
import type { GraphInsertOutcome, SharedVectorFieldHandles } from '../shared-field/types'
import type { VectorStore } from '../vector-store'
import { REBUILD_REMOVED_RATIO } from './constants'

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

/**
 * A query searches a vector index through this, and the index on the main
 * thread and a request thread's view over the shared field both satisfy it.
 *
 * @internal
 */
export interface VectorSearcher {
  readonly fieldName: string
  readonly dimension: number
  searchParallel(query: Float32Array, k: number, options: VectorSearchOptions): Promise<VectorScoredResult[]>
  partitionsKnown(): boolean
  assignPartitions(resolve: (docId: string) => number | undefined): void
}

/**
 * The index sends a field's shared structures to this host, which passes them
 * to the request threads holding the index, and it sends the same host the
 * vectors those threads place in the graph.
 *
 * @internal
 */
export interface SharedCopyHost {
  /** This many threads place vectors, which bounds how many batches the index keeps in flight. */
  readonly workerCount: number
  /** Reports whether the host holds the index the field belongs to right now. */
  holdsIndex(indexName: string): boolean
  /** Reports the partition a document belongs to, for a vector the store took before it recorded partitions. */
  resolvePartition(indexName: string, docId: string): number | undefined
  /** Sends the field's handles to every thread holding the index, resolving once each has opened them. */
  loadShared(indexName: string, fieldName: string, handle: string, handles: SharedVectorFieldHandles): Promise<boolean>
  /** Withdraws the handles from every thread holding the index. */
  drop(indexName: string, fieldName: string, handle: string): Promise<void>
  /** Asks one thread to place the ordinals in the graph under that handle, and resolves null where no thread could. */
  insertOrdinals(
    indexName: string,
    fieldName: string,
    handle: string,
    ordinals: Int32Array,
  ): Promise<GraphInsertOutcome | null>
}

export interface VectorWorkerCopyPolicy {
  /** The index may share its field with worker threads when this reads true. */
  enabled: boolean
  /** The pool holds this many workers, and it takes the machine's cores minus one where the caller omits this. */
  count?: number
  /** The field goes to these request threads where the caller names a host, and no vector search pool starts. */
  host?: SharedCopyHost
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

/**
 * The worker threads hold a field in place over shared memory, as a cloned
 * copy where the runtime shares no memory, or on the request threads.
 *
 * @internal
 */
export type WorkerCopyMode = 'shared' | 'clone' | 'hosted'

export interface VectorIndexState {
  readonly indexName: string
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
  /** The graph a build is filling from the store, which a replacement retires its old ordinal in. */
  freshGraph: HNSWIndex | null
  compactedNodeCount: number
  building: boolean
  buildScheduled: boolean
  pendingBuild: Promise<void> | null
  disposed: boolean
  revision: number
  workerCopyPool: VectorSearchPool | null
  workerCopyHandle: string | null
  workerCopyRevision: number
  workerCopyMode: WorkerCopyMode | null
  workerCopyLoading: boolean
  /** This maps each graph the threads hold to its handle and the way they hold it, and the null key stands for the vectors alone. */
  readonly sharedHandles: Map<HNSWIndex | null, { handle: string; searchable: boolean; mode: WorkerCopyMode }>
  /** The threads hold this many blocks, so the index sends the handles again once the store adds one. */
  sharedBlockCount: number
  /** This is the share in flight, which the index chains so that two shares stay apart. */
  sharing: Promise<void>
}

export function liveSize(state: VectorIndexState): number {
  return state.store.size - state.tombstones.size
}

/**
 * Records the partition of every stored vector that has none, asking the
 * caller for each document's partition.
 *
 * @param state The index whose store to fill in.
 * @param resolve Reports a document's partition, or undefined where the index
 * holds no such document.
 *
 * @internal
 */
export function assignStorePartitions(state: VectorIndexState, resolve: (docId: string) => number | undefined): void {
  for (let ordinal = 0; ordinal < state.store.slots; ordinal += 1) {
    if (state.store.partitionOfOrdinal(ordinal) !== undefined) continue
    const docId = state.store.docIdForOrdinal(ordinal)
    if (docId === undefined) continue
    const partitionId = resolve(docId)
    if (partitionId === undefined) {
      state.store.forgetPartition(docId)
      continue
    }
    state.store.setPartition(docId, partitionId)
  }
}

/**
 * Makes a graph built from every live vector the one the index answers from,
 * or clears the graph away where none is given.
 *
 * The new graph takes a tombstone for every document a caller removed while
 * the threads built it, and the count of nodes compaction cut out of the
 * previous graph starts again from zero.
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
 * Reports whether callers have removed more than a fifth of the vectors the
 * graph has held since the index last built it, which is the point at which
 * the vector index specification requires a rebuild.
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
 * The store keeps each vector's partition, so this walks the ordinals
 * themselves, and it clears the removed documents the index has yet to
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

/**
 * Builds the handles a thread opens to hold this field in place.
 *
 * @param state The index to share.
 * @param graph The graph the handles carry.
 * @param searchable Whether the threads answer searches from that graph.
 * @returns The handles.
 *
 * @internal
 */
export function fieldHandlesOf(
  state: VectorIndexState,
  graph: HNSWIndex | null,
  searchable: boolean,
): SharedVectorFieldHandles {
  return {
    dimension: state.dimension,
    quantization: state.sq8 === null ? 'none' : 'sq8',
    store: state.store.handles,
    graph: graph === null ? null : graph.handles,
    filterThreshold: state.filterThreshold,
    searchable,
  }
}
