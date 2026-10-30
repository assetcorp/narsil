import type { SearchClock } from '../../core/search-clock'
import type { VectorQuantizationMode, VectorStorageMode } from '../../types/schema'
import type { VectorMetric } from '../brute-force'
import { type FilterSubset, type OrdinalSpace, ordinalFilterForSubsets } from '../filter-ordinals'
import type { HNSWConfig, HNSWIndex } from '../hnsw'
import { createOrdinalFilter, type OrdinalFilter, removeFromOrdinalFilter } from '../ordinal-filter'
import type { OsqQuantizer } from '../osq'
import type { VectorSearchPool } from '../search-pool'
import type { GraphInsertOutcome, SharedVectorFieldHandles } from '../shared-field/types'
import type { VectorStore } from '../vector-store'
import { STORE_ORDINAL_LAYOUT_GENERATION } from '../vector-store/handles'
import type { FieldSignature, SavedVectorFile } from './checkpoint-plan'
import { BUILD_TURN_HANDOVER_AFTER_MS, DRIFT_CHECK_GROWTH_FACTOR, REBUILD_REMOVED_RATIO } from './constants'
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
  filterSubsets?: readonly FilterSubset[]
  /** The partitions the search may answer from, which the index resolves to ordinals itself. */
  filterPartitions?: ReadonlySet<number>
  efSearch?: number
  /** A quantized index re-scores this many times the requested count against full precision. */
  oversample?: number
  rescoreWindow?: number
  clock?: SearchClock
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
  waitingForMemory: boolean
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
  shuffledBuildCount: number | null
  calibratedCount: number | null
  calibratedMeanLength: number | null
  nextDriftCheckAt: number
  shuffledRebuild: Promise<void> | null
  /** The bytes that the field holds against the node's memory for a shuffled rebuild in progress. */
  rebuildChargeBytes: number
  /** This stays true while a due shuffled rebuild waits for the node's memory to make room for a second graph. */
  waitingForMemory: boolean
  rebuildWaitTimer: ReturnType<typeof setTimeout> | null
  readonly onLoadedGraphRepaired: () => void
  compactedNodeCount: number
  building: boolean
  buildScheduled: boolean
  buildTimer: ReturnType<typeof setTimeout> | null
  buildRetryDelayMs: number
  readonly buildTurnWaiters: Map<() => void, number>
  pendingBuild: Promise<void> | null
  disposed: boolean
  revision: number
  workerCopyPool: VectorSearchPool | null
  workerCopyHandle: string | null
  workerCopyRevision: number
  workerCopyMode: WorkerCopyMode | null
  workerCopyLoading: boolean
  workerCopiesHeld: boolean
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
  forgetCalibration(state)
  state.savedFiles = []
  state.savedSignature = null
}

export function releaseReplacedVectors(state: VectorIndexState): void {
  for (const ordinal of state.store.releaseReplacedVectors()) state.osq?.removeOrdinal(ordinal)
}

export function adoptGraph(state: VectorIndexState, graph: HNSWIndex | null): void {
  if (state.hnsw !== null && state.hnsw !== graph) state.hnsw.retire()
  if (graph === null && state.hnsw !== null) {
    state.hnsw.clear()
  }
  state.hnsw = graph
  state.shuffledBuildCount = null
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

export function yieldBuildTurn(state: VectorIndexState): Promise<void> {
  return new Promise(resolve => {
    const takeTurn = (): void => {
      clearTimeout(timer)
      state.buildTurnWaiters.delete(takeTurn)
      resolve()
    }
    const timer = setTimeout(takeTurn, 0)
    state.buildTurnWaiters.set(takeTurn, performance.now())
  })
}

export function noBuildHistory(): Pick<
  VectorIndexState,
  'shuffledBuildCount' | 'calibratedCount' | 'calibratedMeanLength' | 'nextDriftCheckAt' | 'shuffledRebuild'
> {
  return {
    shuffledBuildCount: null,
    calibratedCount: null,
    calibratedMeanLength: null,
    nextDriftCheckAt: Number.POSITIVE_INFINITY,
    shuffledRebuild: null,
  }
}

export function handOverBuildTurns(state: VectorIndexState): void {
  if (state.buildTurnWaiters.size === 0) return
  const [longestWaitingSince] = state.buildTurnWaiters.values()
  if (longestWaitingSince === undefined || performance.now() - longestWaitingSince < BUILD_TURN_HANDOVER_AFTER_MS)
    return
  for (const takeTurn of [...state.buildTurnWaiters.keys()]) takeTurn()
}

export function* allLiveDocIds(state: VectorIndexState): Iterable<string> {
  for (const docId of state.store.docIds()) {
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

function ordinalSpaceOf(state: VectorIndexState): OrdinalSpace {
  const store = state.store
  const handles = store.handles
  const removed = new Uint8Array(handles.removed)
  return {
    fieldName: state.fieldName,
    slots: store.slots,
    header: handles.header,
    layoutGeneration: Atomics.load(handles.header, STORE_ORDINAL_LAYOUT_GENERATION),
    ordinalOf: docId => store.getOrdinal(docId),
    holdsCurrentOrdinal: ordinal => store.holdsOrdinal(ordinal),
    isRemoved: ordinal => ordinal < removed.length && removed[ordinal] === 1,
  }
}

export function filterForOptions(
  state: VectorIndexState,
  options: { filterSubsets?: readonly FilterSubset[]; filterPartitions?: ReadonlySet<number> },
): OrdinalFilter | undefined {
  if (options.filterSubsets !== undefined) {
    if (state.store.dimension === 0) return createOrdinalFilter(0)
    return ordinalFilterForSubsets(options.filterSubsets, ordinalSpaceOf(state))
  }
  if (options.filterPartitions !== undefined) {
    return ordinalFilterForPartitions(state, options.filterPartitions)
  }
  return undefined
}

export function liveOrdinals(state: VectorIndexState): Int32Array {
  const ordinals: number[] = []
  for (let ordinal = 0; ordinal < state.store.slots; ordinal++) {
    const docId = state.store.docIdForOrdinal(ordinal)
    if (docId !== undefined && !state.tombstones.has(docId)) ordinals.push(ordinal)
  }
  return Int32Array.from(ordinals)
}

export function forgetCalibration(state: VectorIndexState): void {
  state.calibratedCount = null
  state.calibratedMeanLength = null
  state.nextDriftCheckAt = Number.POSITIVE_INFINITY
}

export function adoptLoadedCalibration(
  state: VectorIndexState,
  calibratedCount: number,
  calibratedMeanLength: number | null,
): void {
  if (state.osq === null || !state.osq.isCalibrated()) return
  state.calibratedCount = calibratedCount
  state.calibratedMeanLength = calibratedMeanLength
  state.nextDriftCheckAt = Math.max(1, calibratedCount) * DRIFT_CHECK_GROWTH_FACTOR
}

export function recalibrateFromStore(state: VectorIndexState): void {
  if (state.osq === null) return
  const ordinals = liveOrdinals(state)
  state.osq.recalibrate(ordinals)
  state.calibratedCount = ordinals.length
  state.calibratedMeanLength = null
  state.nextDriftCheckAt = Math.max(1, ordinals.length) * DRIFT_CHECK_GROWTH_FACTOR
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
