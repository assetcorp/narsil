import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorIndexConfig, VectorQuantizationMode, VectorStorageMode } from '../../types/schema'
import type { VectorMetric } from '../brute-force'
import { DISK_STORAGE_BLOCK_BYTES } from '../constants'
import type { HNSWConfig } from '../hnsw'
import { createOsqQuantizer, osqBitsOf } from '../osq'
import { createVectorStore } from '../vector-store'
import { awaitBuilds, disposeIndex, scheduleBuild as scheduleBuildOp, startShuffledRebuild } from './build'
import {
  planCheckpoint as planCheckpointOp,
  recordCheckpoint as recordCheckpointOp,
  type VectorCheckpointPlan,
  type WrittenVectorFile,
} from './checkpoint-plan'
import { beginCheckpointRestore, type CheckpointRestoreShape, type VectorCheckpointRestore } from './checkpoint-restore'
import {
  type ColdFieldLoad,
  cancelColdHold,
  coldHas,
  coldSearch,
  coldSearchConcurrently,
  coldVectorOf,
  openColdField,
} from './cold'
import { DEFAULT_FILTER_THRESHOLD, DEFAULT_PROMOTION_THRESHOLD, OSQ4_MIN_DIMENSION } from './constants'
import { adoptDiskLayout as adoptDiskLayoutOp, type VectorFileLayout } from './disk'
import { createRemovedDocuments, createUnplacedVectors } from './flagged-documents'
import {
  compact as compactOp,
  completeGraph as completeGraphOp,
  estimateMemoryBytes as estimateMemoryBytesOp,
  maintenanceStatus as maintenanceStatusOp,
  optimize as optimizeOp,
} from './maintenance'
import type { VectorIndexPayload } from './payload'
import { deserialize as deserializeOp } from './persistence'
import { fetchedOutcome, search as searchOp, searchWithFilter, withBufferedVectors } from './search'
import {
  assignStorePartitions,
  type ColdVectorField,
  filterForOptions,
  handOverBuildTurns,
  liveSize,
  type MaintenanceStatus,
  noBuildHistory,
  VECTOR_WORKER_COPIES_ALLOWED,
  type VectorIndexState,
  type VectorSearchOptions,
  type VectorSearchOutcome,
  type VectorWorkerCopyPolicy,
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

export interface VectorIndex {
  insert(docId: string, vector: Float32Array, partitionId?: number): void
  remove(docId: string): void
  /** Reports whether every stored vector names the partition it belongs to. */
  partitionsKnown(): boolean
  assignPartitions(resolve: (docId: string) => number | undefined): void
  scheduleBuild(): void
  awaitPendingBuild(): Promise<void>
  /** Places every live vector in the graph, building one where the field holds none and enough vectors for one, and resolves once every vector is in. A checkpoint calls this so that the parts it writes carry the graph. */
  completeGraph(): Promise<void>
  dispose(): void
  search(query: Float32Array, k: number, options: VectorSearchOptions): VectorSearchOutcome
  searchParallel(query: Float32Array, k: number, options: VectorSearchOptions): Promise<VectorSearchOutcome>
  /** Withdraws the field from the worker threads and sends it again where the policy names a host. */
  refreshWorkerCopies(): void
  getVector(docId: string): Float32Array | null
  has(docId: string): boolean
  compact(): void
  optimize(): Promise<void>
  maintenanceStatus(): MaintenanceStatus
  estimateMemoryBytes(): number
  /** Reports the bytes that storing this many more vectors would add to the field's shared structures. */
  growthBytesFor(vectors: number): number
  /** Reads the field back from the parts of an earlier snapshot, whose parts can place the sequences of several partitions end to end, and keeps every vector in memory. */
  deserialize(parts: VectorIndexPayload[]): void
  /** Fixes what a checkpoint writes for the field now: the vector files that it keeps with their dead vectors, the vectors that go into new files, and the graph with every vector numbered by that file list. The plan reads one new file at a time, so that a checkpoint holds one file in memory while it writes a field of any size. */
  planCheckpoint(listedKeys: readonly string[] | null, rewritesGraph?: boolean): VectorCheckpointPlan
  /** Records the files of a checkpoint whose manifest is durable, so that the next plan writes the vectors that arrive after it and no others. */
  recordCheckpoint(plan: VectorCheckpointPlan, written: readonly WrittenVectorFile[]): void
  /** Empties the field and returns a reader that takes a checkpoint's vector files one at a time, in manifest order, after the graph that `shape` carries. A field kept on disk reads its vectors from the files where the checkpoint holds a graph or enough vectors for one, and a dead vector that the graph holds a node for comes back as a tombstone. */
  restoreCheckpoint(shape: CheckpointRestoreShape): VectorCheckpointRestore
  /** Answers from the field's files by position while `load` restores its codes and graph, and it holds any write until that load ends. */
  openColdField(field: ColdVectorField, load: ColdFieldLoad): void
  startShuffledRebuildWhenDue(): void
  /** Lists the paths of the vector files that the field still reads vectors from. */
  vectorFilesInUse(): string[]
  /** Points the vectors a checkpoint wrote at their places in its file and frees the blocks they emptied, or keeps those places while the field holds no graph. It resolves once every thread holding the field has taken the new layout. */
  adoptDiskLayout(layout: VectorFileLayout): Promise<void>
  /** Withdraws the field from every thread that holds a copy of it and closes every vector file that this thread holds open or maps, so that the caller can delete those files on any platform. It resolves once every thread has closed its copy, and the field opens a file again when a search next reads a vector from it. */
  releaseVectorFiles(): Promise<void>
  relocateVectorFiles(rewrite: (path: string) => string): void
  holdWorkerCopies(): Promise<void>
  resumeWorkerCopies(): void

  readonly size: number
  readonly dimension: number
  readonly fieldName: string
  /** The mode the field codes its vectors in. */
  readonly quantization: VectorQuantizationMode
  /** Where the field keeps its full-precision vectors. */
  readonly storage: VectorStorageMode
  readonly metric: VectorMetric
}

export function defaultQuantizationFor(dimension: number): VectorQuantizationMode {
  if (dimension >= OSQ4_MIN_DIMENSION) return 'osq4'
  return 'osq8'
}

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

  const promotionThreshold = config?.threshold ?? DEFAULT_PROMOTION_THRESHOLD
  const filterThreshold = Math.max(0, Math.min(1, config?.filterThreshold ?? DEFAULT_FILTER_THRESHOLD))
  const quantizationMode = config?.quantization ?? defaultQuantizationFor(dimension)
  const codeBits = osqBitsOf(quantizationMode)
  const metric = config?.hnswConfig?.metric ?? 'cosine'
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

  async function whenLoaded(): Promise<void> {
    while (state.cold !== null) await state.cold.loaded
  }

  async function searchParallel(
    query: Float32Array,
    k: number,
    options: VectorSearchOptions,
  ): Promise<VectorSearchOutcome> {
    if (state.cold !== null) return coldSearchConcurrently(state, state.cold, query, k, options)
    handOverBuildTurns(state)
    const confined = options.filterSubsets !== undefined || options.filterPartitions !== undefined
    let filter = filterForOptions(state, options)
    if (filter !== undefined) {
      if (state.hnsw) {
        const hnswLiveSize = state.hnsw.size
        const selectivity = hnswLiveSize > 0 ? filter.count / hnswLiveSize : 1
        if (selectivity < state.filterThreshold) {
          return searchWithFilter(state, query, k, options, filter)
        }
      }
    }
    const filterRevision = state.revision
    const buffered = state.buffer.size === 0 ? null : [...state.buffer]

    scheduleWorkerCopyLoad(state)

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
    return searchWithFilter(state, query, k, options, filter)
  }

  return {
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
      disposeIndex(state)
    },
    search: (query: Float32Array, k: number, options: VectorSearchOptions) =>
      state.cold === null ? searchOp(state, query, k, options) : coldSearch(state, state.cold, query, k, options),
    searchParallel,
    refreshWorkerCopies: () => {
      if (state.cold === null) refreshWorkerCopies(state)
    },
    getVector,
    has,
    compact: () => {
      if (state.cold !== null) return
      noteWrite(state)
      compactOp(state)
    },
    optimize: async () => {
      await whenLoaded()
      noteWrite(state)
      await optimizeOp(state)
    },
    maintenanceStatus: () => ({ ...maintenanceStatusOp(state), loadingFromFiles: state.cold !== null }),
    estimateMemoryBytes: () => estimateMemoryBytesOp(state) + (state.cold?.field.residentBytes ?? 0),
    growthBytesFor: (vectors: number) => state.store.growthBytesFor(vectors),
    deserialize: (parts: VectorIndexPayload[]) => {
      cancelColdHold(state)
      invalidateWorkerCopies(state)
      deserializeOp(state, parts)
    },
    planCheckpoint: (listedKeys: readonly string[] | null, rewritesGraph?: boolean) =>
      planCheckpointOp(state, listedKeys, rewritesGraph),
    recordCheckpoint: (plan: VectorCheckpointPlan, written: readonly WrittenVectorFile[]) =>
      recordCheckpointOp(state, plan, written),
    restoreCheckpoint: (shape: CheckpointRestoreShape) => {
      cancelColdHold(state)
      invalidateWorkerCopies(state)
      return beginCheckpointRestore(state, shape)
    },
    openColdField: (field: ColdVectorField, load: ColdFieldLoad) => openColdField(state, field, load),
    startShuffledRebuildWhenDue: () => {
      if (state.cold === null) startShuffledRebuild(state)
    },
    vectorFilesInUse: () => {
      const stored = state.store.dimension === 0 ? [] : state.store.handles.vectorFiles.filter(path => path !== '')
      return state.cold === null ? stored : [...stored, ...state.cold.field.filePaths()]
    },
    adoptDiskLayout: (layout: VectorFileLayout) => adoptDiskLayoutOp(state, layout),
    releaseVectorFiles: async () => {
      await whenLoaded()
      await withdrawWorkerCopies(state)
      state.store.closeFiles()
    },
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
