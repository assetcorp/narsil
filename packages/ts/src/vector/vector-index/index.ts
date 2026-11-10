import { closeIdleTurnHop, shareTurnsWithBackgroundWork } from '#platform/background-turn-sharing'
import {
  assignStorePartitions,
  createOsqQuantizer,
  DEFAULT_FILTER_THRESHOLD,
  DEFAULT_PROMOTION_THRESHOLD,
  DEFAULT_VECTOR_METRIC,
  DISK_STORAGE_BLOCK_BYTES,
  defaultQuantizationFor,
  deserialize as deserializeOp,
  ErrorCodes,
  filterForOptions,
  handOverBuildTurns,
  liveSize,
  NarsilError,
  noBuildHistory,
  osqBitsOf,
  planCheckpoint as planCheckpointOp,
  recordCheckpoint as recordCheckpointOp,
  VECTOR_WORKER_COPIES_ALLOWED,
} from '#platform/vector-host'
import type { VectorIndexConfig, VectorStorageMode } from '../../types/schema'
import type { HNSWConfig } from '../hnsw'
import { createVectorStore } from '../vector-store'
import { awaitBuilds, disposeIndex, scheduleBuild as scheduleBuildOp, startShuffledRebuild } from './build'
import type { VectorCheckpointPlan, WrittenVectorFile } from './checkpoint-plan'
import { beginCheckpointRestore, type CheckpointRestoreShape } from './checkpoint-restore'
import {
  type ColdFieldLoad,
  cancelColdHold,
  coldHas,
  coldSearch,
  coldSearchConcurrently,
  coldVectorOf,
  openColdField,
  untilColdLoaded,
} from './cold'
import { adoptDiskLayout as adoptDiskLayoutOp, type VectorFileLayout } from './disk'
import { createRemovedDocuments, createUnplacedVectors } from './flagged-documents'
import { onceGraphFree, untilGraphReleased, withGraphFree } from './graph-pass'
import type { VectorIndex } from './index-types'
import {
  compact as compactOp,
  completeGraph as completeGraphOp,
  estimateMemoryBytes as estimateMemoryBytesOp,
  maintenanceStatus as maintenanceStatusOp,
  optimize as optimizeOp,
} from './maintenance'
import type { VectorIndexPayload } from './payload'
import { vectorPublicationSource } from './publication'
import { fetchedOutcome, search as searchOp, withBufferedVectors } from './search'
import { searchFiltered } from './search-in-turns'
import { searchOffThread } from './search-off-thread'
import { writeWatchesOf } from './search-writes'
import type {
  ColdVectorField,
  VectorIndexState,
  VectorSearchOptions,
  VectorSearchOutcome,
  VectorWorkerCopyPolicy,
} from './shared'
import {
  holdWorkerCopies,
  invalidateWorkerCopies,
  noteWrite,
  refreshWorkerCopies,
  scheduleWorkerCopyLoad,
  searchViaWorkerCopies,
  withdrawWorkerCopies,
} from './worker-copies'
import { createVectorWrites } from './writes'

export type { VectorFilePayload, VectorGraphPayload } from './checkpoint-payload'
export type { VectorCheckpointPlan, WrittenVectorFile } from './checkpoint-plan'
export type { CheckpointRestoreShape, VectorCheckpointRestore } from './checkpoint-restore'
export type { VectorFileLayout, VectorPartFile } from './disk'
export type { VectorIndex } from './index-types'
export type { VectorIndexCodes, VectorIndexPayload } from './payload'
export type {
  ColdVectorField,
  MaintenanceStatus,
  SharedCopyHost,
  VectorScoredResult,
  VectorSearcher,
  VectorSearchOptions,
  VectorSearchOutcome,
  VectorWorkerCopyPolicy,
} from './shared'

export function createVectorIndex(
  fieldName: string,
  dimension: number,
  config?: VectorIndexConfig,
  workerCopies: VectorWorkerCopyPolicy = VECTOR_WORKER_COPIES_ALLOWED,
  indexName = '',
  storage: VectorStorageMode = 'memory',
  onLoadedGraphRepaired: () => void = () => undefined,
): VectorIndex {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new NarsilError(
      ErrorCodes.VECTOR_DIMENSION_MISMATCH,
      `Vector dimension must be a positive integer, got ${dimension}`,
      { dimension },
    )
  }

  shareTurnsWithBackgroundWork()
  const promotionThreshold = config?.threshold ?? DEFAULT_PROMOTION_THRESHOLD
  const filterThreshold = Math.max(0, Math.min(1, config?.filterThreshold ?? DEFAULT_FILTER_THRESHOLD))
  const quantizationMode = config?.quantization ?? defaultQuantizationFor(dimension)
  const codeBits = osqBitsOf(quantizationMode)
  const metric = config?.hnswConfig?.metric ?? DEFAULT_VECTOR_METRIC
  const rawHnswM = config?.hnswConfig?.m
  const hnswConfig: HNSWConfig | undefined = config?.hnswConfig
    ? { ...config.hnswConfig, m: rawHnswM !== undefined ? Math.max(rawHnswM, 2) : undefined }
    : undefined
  const dimensionScale = dimension / 256
  const store = createVectorStore({
    dimension,
    codeBits,
    ...(storage === 'disk' ? { blockBytes: DISK_STORAGE_BLOCK_BYTES } : {}),
  })

  const state: VectorIndexState = {
    indexName,
    fieldName,
    dimension,
    dimensionScale,
    promotionThreshold,
    filterThreshold,
    quantizationMode,
    storage,
    metric,
    hnswConfig,
    workerCopies,
    store,
    tombstones: createRemovedDocuments(store),
    buffer: createUnplacedVectors(store),
    pendingLocations: new Map(),
    savedFiles: [],
    savedSignature: null,
    osq: codeBits === null ? null : createOsqQuantizer(dimension, codeBits, metric, store),
    hnsw: null,
    freshGraph: null,
    ...noBuildHistory(),
    rebuildChargeBytes: 0,
    waitingForMemory: false,
    rebuildWaitTimer: null,
    onLoadedGraphRepaired,
    compactedNodeCount: 0,
    building: false,
    buildScheduled: false,
    scheduledBuild: null,
    buildTimer: null,
    buildRetryDelayMs: 0,
    buildTurnWaiters: new Map(),
    pendingBuild: null,
    disposed: false,
    revision: 0,
    workerCopyPool: null,
    workerCopyHandle: null,
    workerCopyRevision: -1,
    workerCopyMode: null,
    workerCopyLoading: false,
    workerCopiesHeld: false,
    sharedHandles: new Map(),
    sharedLayoutRevision: 0,
    sharing: Promise.resolve(),
    releaseToFilesInFlight: Promise.resolve(),
    cold: null,
    graphsHeldOffThread: null,
    graphsPlacedIntoSinceConnect: new WeakSet(),
    searchWatches: new Set(),
    writeListeners: new Set(),
  }

  const { insert, remove } = createVectorWrites(state)

  function getVector(docId: string): Float32Array | null {
    if (state.cold !== null) return coldVectorOf(state.cold, docId)
    if (state.tombstones.has(docId)) return null
    const entry = state.store.get(docId)
    if (!entry) return null
    return new Float32Array(entry.vector)
  }

  function has(docId: string): boolean {
    if (state.cold !== null) return coldHas(state.cold, docId)
    return state.store.has(docId) && !state.tombstones.has(docId)
  }

  const whenLoaded = (): Promise<void> => untilColdLoaded(state)

  async function searchParallel(
    query: Float32Array,
    k: number,
    options: VectorSearchOptions,
  ): Promise<VectorSearchOutcome> {
    if (state.graphsHeldOffThread !== null) await untilGraphReleased(state)
    if (state.cold !== null) return coldSearchConcurrently(state, state.cold, query, k, options)
    handOverBuildTurns(state)
    const confined = options.filterSubsets !== undefined || options.filterPartitions !== undefined
    let filter = filterForOptions(state, options)
    const offThread = searchOffThread(state, query, k, options, filter, confined ? state.revision : null)
    if (offThread !== null) return offThread
    if (filter !== undefined) {
      if (state.hnsw) {
        const hnswLiveSize = state.hnsw.size
        const selectivity = hnswLiveSize > 0 ? filter.count / hnswLiveSize : 1
        if (selectivity < state.filterThreshold) return searchFiltered(state, query, k, options, filter)
      }
    }
    const filterRevision = state.revision
    scheduleWorkerCopyLoad(state)
    const searchesWorkerCopies = state.workerCopyPool !== null && state.workerCopyHandle !== null
    const buffered = state.buffer.size === 0 || !searchesWorkerCopies ? null : [...state.buffer]

    const viaWorkerCopy = await searchViaWorkerCopies(state, query, k, options.metric, options.minSimilarity, {
      filter,
      efSearch: options.efSearch,
      oversample: options.oversample,
      rescoreWindow: options.rescoreWindow,
    })
    if (confined && state.revision !== filterRevision) {
      filter = filterForOptions(state, options)
    }
    if (viaWorkerCopy !== null) {
      const results =
        buffered === null
          ? viaWorkerCopy
          : withBufferedVectors(state, query, k, options, filter, viaWorkerCopy, buffered)
      return fetchedOutcome(state, results, options.minSimilarity, filter)
    }
    return searchFiltered(state, query, k, options, filter)
  }

  return {
    ...vectorPublicationSource(state),
    get size() {
      return liveSize(state)
    },
    get dimension() {
      return state.dimension
    },
    get fieldName() {
      return state.fieldName
    },
    get quantization() {
      return state.quantizationMode
    },
    get storage() {
      return state.storage
    },
    get metric() {
      return state.metric
    },
    insert,
    remove,
    partitionsKnown: () => state.cold !== null || state.store.partitionsKnown,
    assignPartitions: (resolve: (docId: string) => number | undefined) => {
      if (state.cold === null) assignStorePartitions(state, resolve)
    },
    scheduleBuild: () => {
      if (state.cold === null) scheduleBuildOp(state)
    },
    awaitPendingBuild: async () => {
      await whenLoaded()
      await awaitBuilds(state)
    },
    completeGraph: async () => {
      await whenLoaded()
      await completeGraphOp(state)
    },
    dispose: () => {
      cancelColdHold(state)
      return disposeIndex(state).then(closeIdleTurnHop)
    },
    search: withGraphFree(state, (query: Float32Array, k: number, options: VectorSearchOptions) =>
      state.cold === null ? searchOp(state, query, k, options) : coldSearch(state, state.cold, query, k, options),
    ),
    searchParallel,
    ...writeWatchesOf(state),
    refreshWorkerCopies: () => {
      if (state.cold === null) refreshWorkerCopies(state)
    },
    getVector,
    has,
    compact: withGraphFree(state, () => {
      if (state.cold !== null) return
      noteWrite(state)
      compactOp(state)
    }),
    optimize: async () => {
      await whenLoaded()
      noteWrite(state)
      await optimizeOp(state)
    },
    maintenanceStatus: () => ({ ...maintenanceStatusOp(state), loadingFromFiles: state.cold !== null }),
    estimateMemoryBytes: () => estimateMemoryBytesOp(state) + (state.cold?.field.residentBytes ?? 0),
    growthBytesFor: (vectors: number) => state.store.growthBytesFor(vectors),
    deserialize: withGraphFree(state, (parts: VectorIndexPayload[]) => {
      cancelColdHold(state)
      invalidateWorkerCopies(state)
      deserializeOp(state, parts)
    }),
    planCheckpoint: withGraphFree(
      state,
      (listedKeys: readonly string[] | null, rewritesGraph?: boolean, pinsRetiredVectors?: boolean) =>
        planCheckpointOp(state, listedKeys, rewritesGraph, pinsRetiredVectors),
    ),
    recordCheckpoint: (plan: VectorCheckpointPlan, written: readonly WrittenVectorFile[]) =>
      recordCheckpointOp(state, plan, written),
    restoreCheckpoint: withGraphFree(state, (shape: CheckpointRestoreShape) => {
      cancelColdHold(state)
      invalidateWorkerCopies(state)
      return beginCheckpointRestore(state, shape)
    }),
    openColdField: (field: ColdVectorField, load: ColdFieldLoad) => openColdField(state, field, load),
    startShuffledRebuildWhenDue: () => {
      if (state.cold === null) startShuffledRebuild(state)
    },
    vectorFilesInUse: () => {
      const stored = state.store.dimension === 0 ? [] : state.store.handles.vectorFiles.filter(path => path !== '')
      return state.cold === null ? stored : [...stored, ...state.cold.field.filePaths()]
    },
    adoptDiskLayout: onceGraphFree(state, (layout: VectorFileLayout) => adoptDiskLayoutOp(state, layout)),
    releaseVectorFiles: onceGraphFree(state, async () => {
      await whenLoaded()
      await withdrawWorkerCopies(state)
      state.store.closeFiles()
    }),
    relocateVectorFiles: (rewrite: (path: string) => string) => {
      state.store.relocateVectorFiles(rewrite)
      for (const [docId, location] of state.pendingLocations) {
        state.pendingLocations.set(docId, { ...location, path: rewrite(location.path) })
      }
    },
    holdWorkerCopies: async () => {
      await whenLoaded()
      await holdWorkerCopies(state)
    },
    resumeWorkerCopies: () => {
      state.workerCopiesHeld = false
    },
  }
}
