import type { VectorQuantizationMode, VectorStorageMode } from '../../types/schema'
import type { VectorMetric } from '../brute-force'
import type { HNSWConfig, HNSWIndex } from '../hnsw'
import { addToOrdinalFilter, createOrdinalFilter, type OrdinalFilter, removeFromOrdinalFilter } from '../ordinal-filter'
import type { OsqQuantizer } from '../osq'
import type { VectorSearchPool } from '../search-pool'
import type { GraphInsertOutcome, SharedVectorFieldHandles } from '../shared-field/types'
import type { VectorStore } from '../vector-store'
import type { FieldSignature, SavedVectorFile } from './checkpoint-plan'
import { REBUILD_REMOVED_RATIO } from './constants'
import type { PendingVectorLocation } from './disk'

export type { VectorIndexPayload } from './payload'

export interface VectorScoredResult {
  docId: string
  score: number
}

export interface VectorSearchOutcome {
  results: VectorScoredResult[]
  matched: number
  matchedExact: boolean
}

export interface VectorSearchOptions {
  metric: VectorMetric
  minSimilarity: number
  filterDocIds?: Set<string>
  /** The partitions the search may answer from, which the index resolves to ordinals itself. */
  filterPartitions?: ReadonlySet<number>
  efSearch?: number
  /** A quantized index re-scores this many times the requested count against full precision. */
  oversample?: number
}

export interface VectorSearcher {
  readonly fieldName: string
  readonly dimension: number
  searchParallel(query: Float32Array, k: number, options: VectorSearchOptions): Promise<VectorSearchOutcome>
  partitionsKnown(): boolean
  assignPartitions(resolve: (docId: string) => number | undefined): void
}

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

export type WorkerCopyMode = 'shared' | 'clone' | 'hosted'

export interface VectorIndexState {
  readonly indexName: string
  readonly fieldName: string
  readonly dimension: number
  readonly dimensionScale: number
  readonly promotionThreshold: number
  readonly filterThreshold: number
  readonly quantizationMode: VectorQuantizationMode
  readonly storage: VectorStorageMode
  /** The graph ranks by this metric, and the quantizer takes the codes under it. */
  readonly metric: VectorMetric
  readonly hnswConfig: HNSWConfig | undefined
  readonly workerCopies: VectorWorkerCopyPolicy
  readonly store: VectorStore
  readonly tombstones: Set<string>
  readonly buffer: Set<string>
  /** A checkpoint wrote these vectors to a file while the field held no graph, and the field points each at its place once it holds one. */
  readonly pendingLocations: Map<string, PendingVectorLocation>
  /** The vector files that the last committed checkpoint lists for the field, in manifest order. */
  savedFiles: readonly SavedVectorFile[]
  /** What the field looked like when that checkpoint planned its files, and null before the first. */
  savedSignature: FieldSignature | null
  osq: OsqQuantizer | null
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
  /** The threads opened the store at this layout revision, so the index sends the handles again once the store adds or releases a block or a file. */
  sharedLayoutRevision: number
  /** This is the share in flight, which the index chains so that two shares stay apart. */
  sharing: Promise<void>
  releaseToFilesInFlight: Promise<void>
}

export function liveSize(state: VectorIndexState): number {
  return state.store.size - state.tombstones.size
}

export function threadsHoldCurrentLayout(state: VectorIndexState): boolean {
  return state.sharedLayoutRevision === state.store.handles.layoutRevision
}

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

export function emptyFieldBeforeRestore(state: VectorIndexState): void {
  state.store.clear()
  state.tombstones.clear()
  state.buffer.clear()
  state.pendingLocations.clear()
  adoptGraph(state, null)
  state.osq?.clear()
  state.savedFiles = []
  state.savedSignature = null
}

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

export function ordinalFilterForPartitions(state: VectorIndexState, partitionIds: ReadonlySet<number>): OrdinalFilter {
  const filter = state.store.partitionFilter(partitionIds)
  for (const docId of state.tombstones) {
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal === undefined) continue
    removeFromOrdinalFilter(filter, ordinal)
  }
  return filter
}

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

function liveOrdinals(state: VectorIndexState): Int32Array {
  const ordinals: number[] = []
  for (let ordinal = 0; ordinal < state.store.slots; ordinal++) {
    const docId = state.store.docIdForOrdinal(ordinal)
    if (docId !== undefined && !state.tombstones.has(docId)) ordinals.push(ordinal)
  }
  return Int32Array.from(ordinals)
}

export function calibrateQuantizer(state: VectorIndexState): void {
  if (state.osq === null || state.store.size === 0) return
  state.osq.calibrate(liveOrdinals(state))
}

export function recalibrateFromStore(state: VectorIndexState): void {
  if (state.osq === null) return
  state.osq.recalibrate(liveOrdinals(state))
}

export function fieldHandlesOf(
  state: VectorIndexState,
  graph: HNSWIndex | null,
  searchable: boolean,
): SharedVectorFieldHandles {
  return {
    dimension: state.dimension,
    quantization: state.osq === null ? 'none' : state.quantizationMode,
    metric: state.metric,
    store: state.store.handles,
    graph: graph === null ? null : graph.handles,
    filterThreshold: state.filterThreshold,
    searchable,
  }
}
