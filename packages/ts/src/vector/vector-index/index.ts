import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorIndexConfig, VectorQuantizationMode, VectorStorageMode } from '../../types/schema'
import { DISK_STORAGE_BLOCK_BYTES } from '../constants'
import type { HNSWConfig } from '../hnsw'
import { createOsqQuantizer, osqBitsOf } from '../osq'
import { createVectorStore } from '../vector-store'
import { scheduleBuild as scheduleBuildOp } from './build'
import {
  planCheckpoint as planCheckpointOp,
  recordCheckpoint as recordCheckpointOp,
  type VectorCheckpointPlan,
  type WrittenVectorFile,
} from './checkpoint-plan'
import { beginCheckpointRestore, type CheckpointRestoreShape, type VectorCheckpointRestore } from './checkpoint-restore'
import { DEFAULT_FILTER_THRESHOLD, DEFAULT_PROMOTION_THRESHOLD, OSQ4_MIN_DIMENSION } from './constants'
import { adoptDiskLayout as adoptDiskLayoutOp, type VectorFileLayout } from './disk'
import {
  compact as compactOp,
  completeGraph as completeGraphOp,
  estimateMemoryBytes as estimateMemoryBytesOp,
  maintenanceStatus as maintenanceStatusOp,
  optimize as optimizeOp,
} from './maintenance'
import type { VectorIndexPayload } from './payload'
import { deserialize as deserializeOp, serialize as serializeOp } from './persistence'
import { search as searchOp, searchWithFilter } from './search'
import {
  assignStorePartitions,
  filterForOptions,
  liveSize,
  type MaintenanceStatus,
  threadsHoldCurrentLayout,
  VECTOR_WORKER_COPIES_ALLOWED,
  type VectorIndexState,
  type VectorScoredResult,
  type VectorSearchOptions,
  type VectorWorkerCopyPolicy,
} from './shared'
import {
  invalidateWorkerCopies,
  noteWrite,
  refreshWorkerCopies,
  scheduleWorkerCopyLoad,
  searchViaWorkerCopies,
  withdrawWorkerCopies,
} from './worker-copies'

export type { VectorFilePayload, VectorGraphPayload } from './checkpoint-payload'
export type { VectorCheckpointPlan, WrittenVectorFile } from './checkpoint-plan'
export type { CheckpointRestoreShape, VectorCheckpointRestore } from './checkpoint-restore'
export type { VectorFileLayout, VectorPartFile } from './disk'
export type { VectorIndexCodes, VectorIndexPayload } from './payload'
export type {
  MaintenanceStatus,
  SharedCopyHost,
  VectorScoredResult,
  VectorSearcher,
  VectorSearchOptions,
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
  search(query: Float32Array, k: number, options: VectorSearchOptions): VectorScoredResult[]
  searchParallel(query: Float32Array, k: number, options: VectorSearchOptions): Promise<VectorScoredResult[]>
  /** Withdraws the field from the worker threads and sends it again where the policy names a host. */
  refreshWorkerCopies(): void
  getVector(docId: string): Float32Array | null
  has(docId: string): boolean
  compact(): void
  optimize(): Promise<void>
  maintenanceStatus(): MaintenanceStatus
  estimateMemoryBytes(): number
  /** Writes the field as the parts the envelope specification defines, in ordinal order. */
  serialize(): VectorIndexPayload[]
  /** Reads the field back from its parts, which may run several partitions' sequences end to end, and holds every vector in memory. */
  deserialize(parts: VectorIndexPayload[]): void
  /** Fixes what a checkpoint writes for the field now: the vector files that it keeps with their dead vectors, the vectors that go into new files, and the graph with every vector numbered by that file list. The plan reads one new file at a time, so that a checkpoint holds one file in memory while it writes a field of any size. A file read after a recalibration throws, because its codes would disagree with the centroid of the files before it. */
  planCheckpoint(listedKeys: readonly string[] | null): VectorCheckpointPlan
  /** Records the files of a checkpoint whose manifest is durable, so that the next plan writes the vectors that arrive after it and no others. */
  recordCheckpoint(plan: VectorCheckpointPlan, written: readonly WrittenVectorFile[]): void
  /** Empties the field and returns a reader that takes a checkpoint's vector files one at a time, in manifest order, and its graph last. A field kept on disk reads its vectors from the files where the checkpoint holds a graph or enough vectors for one. */
  restoreCheckpoint(shape: CheckpointRestoreShape): VectorCheckpointRestore
  /** Lists the paths of the vector files that the field still reads vectors from. */
  vectorFilesInUse(): string[]
  /** Points the vectors a checkpoint wrote at their places in its file and frees the blocks they emptied, or keeps those places while the field holds no graph. It resolves once every thread holding the field has taken the new layout. */
  adoptDiskLayout(layout: VectorFileLayout): Promise<void>
  /** Withdraws the field from every thread that holds a copy of it and closes every vector file that this thread holds open or maps, so that the caller can delete those files on any platform. It resolves once every thread has closed its copy, and the field opens a file again when a search next reads a vector from it. */
  releaseVectorFiles(): Promise<void>

  readonly size: number
  readonly dimension: number
  readonly fieldName: string
  /** The mode the field codes its vectors in. */
  readonly quantization: VectorQuantizationMode
  /** Where the field keeps its full-precision vectors. */
  readonly storage: VectorStorageMode
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
    tombstones: new Set<string>(),
    buffer: new Set<string>(),
    pendingLocations: new Map(),
    savedFiles: [],
    savedSignature: null,
    osq: codeBits === null ? null : createOsqQuantizer(dimension, codeBits, metric, store),
    hnsw: null,
    freshGraph: null,
    compactedNodeCount: 0,
    building: false,
    buildScheduled: false,
    pendingBuild: null,
    disposed: false,
    revision: 0,
    workerCopyPool: null,
    workerCopyHandle: null,
    workerCopyRevision: -1,
    workerCopyMode: null,
    workerCopyLoading: false,
    sharedHandles: new Map(),
    sharedLayoutRevision: 0,
    sharing: Promise.resolve(),
    releaseToFilesInFlight: Promise.resolve(),
  }

  function validateDimension(vector: Float32Array): void {
    if (vector.length !== state.dimension) {
      throw new NarsilError(
        ErrorCodes.VECTOR_DIMENSION_MISMATCH,
        `Vector dimension mismatch: expected ${state.dimension}, got ${vector.length}`,
        { expected: state.dimension, received: vector.length },
      )
    }
  }

  function heldVectorOrUndefinedWhereItsFileFailsToRead(ordinal: number): Float32Array | undefined {
    try {
      return state.store.entryForOrdinal(ordinal)?.vector
    } catch {
      return undefined
    }
  }

  function holdsThisVectorAlready(docId: string, ordinal: number, vector: Float32Array): boolean {
    if (state.tombstones.has(docId)) return false
    const held = heldVectorOrUndefinedWhereItsFileFailsToRead(ordinal)
    if (held === undefined) return false
    for (let i = 0; i < vector.length; i++) if (held[i] !== vector[i]) return false
    return true
  }

  function insert(docId: string, vector: Float32Array, partitionId?: number): void {
    validateDimension(vector)
    const previous = state.store.getOrdinal(docId)
    if (previous !== undefined && holdsThisVectorAlready(docId, previous, vector)) {
      if (partitionId !== undefined && state.store.partitionOfOrdinal(previous) !== partitionId) {
        noteWrite(state)
        state.store.setPartition(docId, partitionId)
      }
      return
    }
    noteWrite(state)
    state.tombstones.delete(docId)
    state.store.insert(docId, vector, partitionId)
    if (previous !== undefined) {
      state.hnsw?.markTombstoneOrdinal(previous)
      state.freshGraph?.markTombstoneOrdinal(previous)
      state.osq?.removeOrdinal(previous)
    }
    state.buffer.add(docId)
    state.pendingLocations.delete(docId)
    if (!threadsHoldCurrentLayout(state)) scheduleWorkerCopyLoad(state)
  }

  function remove(docId: string): void {
    if (!state.store.has(docId)) return
    noteWrite(state)
    state.tombstones.add(docId)
    state.buffer.delete(docId)
    state.pendingLocations.delete(docId)
    if (state.hnsw) {
      state.hnsw.markTombstone(docId)
    }
  }

  function getVector(docId: string): Float32Array | null {
    if (state.tombstones.has(docId)) return null
    const entry = state.store.get(docId)
    if (!entry) return null
    return new Float32Array(entry.vector)
  }

  function has(docId: string): boolean {
    return state.store.has(docId) && !state.tombstones.has(docId)
  }

  async function awaitPendingBuild(): Promise<void> {
    while (state.pendingBuild) {
      await state.pendingBuild
    }
  }

  function releaseHeldMemory(): void {
    state.hnsw = null
    state.freshGraph = null
    state.osq = null
    state.tombstones.clear()
    state.buffer.clear()
    state.pendingLocations.clear()
    state.savedFiles = []
    state.savedSignature = null
    state.store.release()
  }

  function dispose(): void {
    state.disposed = true
    invalidateWorkerCopies(state)
    const pending = state.pendingBuild
    if (pending !== null) {
      void pending.then(releaseHeldMemory, releaseHeldMemory)
      return
    }
    releaseHeldMemory()
  }

  async function searchParallel(
    query: Float32Array,
    k: number,
    options: VectorSearchOptions,
  ): Promise<VectorScoredResult[]> {
    const confined = options.filterDocIds !== undefined || options.filterPartitions !== undefined
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

    scheduleWorkerCopyLoad(state)

    const viaWorkerCopy = await searchViaWorkerCopies(state, query, k, options.metric, options.minSimilarity, {
      filter,
      efSearch: options.efSearch,
      oversample: options.oversample,
    })
    if (viaWorkerCopy !== null) return viaWorkerCopy

    if (confined && state.revision !== filterRevision) {
      filter = filterForOptions(state, options)
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
    insert,
    remove,
    partitionsKnown: () => state.store.partitionsKnown,
    assignPartitions: (resolve: (docId: string) => number | undefined) => assignStorePartitions(state, resolve),
    scheduleBuild: () => scheduleBuildOp(state),
    awaitPendingBuild,
    completeGraph: () => completeGraphOp(state),
    dispose,
    search: (query: Float32Array, k: number, options: VectorSearchOptions) => searchOp(state, query, k, options),
    searchParallel,
    refreshWorkerCopies: () => refreshWorkerCopies(state),
    getVector,
    has,
    compact: () => {
      noteWrite(state)
      compactOp(state)
    },
    optimize: async () => {
      noteWrite(state)
      await optimizeOp(state)
    },
    maintenanceStatus: () => maintenanceStatusOp(state),
    estimateMemoryBytes: () => estimateMemoryBytesOp(state),
    serialize: () => serializeOp(state),
    deserialize: (parts: VectorIndexPayload[]) => {
      invalidateWorkerCopies(state)
      deserializeOp(state, parts)
    },
    planCheckpoint: (listedKeys: readonly string[] | null) => planCheckpointOp(state, listedKeys),
    recordCheckpoint: (plan: VectorCheckpointPlan, written: readonly WrittenVectorFile[]) =>
      recordCheckpointOp(state, plan, written),
    restoreCheckpoint: (shape: CheckpointRestoreShape) => {
      invalidateWorkerCopies(state)
      return beginCheckpointRestore(state, shape)
    },
    vectorFilesInUse: () =>
      state.store.dimension === 0 ? [] : state.store.handles.vectorFiles.filter(path => path !== ''),
    adoptDiskLayout: (layout: VectorFileLayout) => adoptDiskLayoutOp(state, layout),
    releaseVectorFiles: async () => {
      await withdrawWorkerCopies(state)
      state.store.closeFiles()
    },
  }
}
