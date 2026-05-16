import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorIndexConfig } from '../../types/schema'
import type { HNSWConfig } from '../hnsw'
import { createScalarQuantizer } from '../scalar-quantization'
import { createVectorStore } from '../vector-store'
import { scheduleBuild as scheduleBuildOp } from './build'
import {
  compact as compactOp,
  estimateMemoryBytes as estimateMemoryBytesOp,
  maintenanceStatus as maintenanceStatusOp,
  optimize as optimizeOp,
} from './maintenance'
import { deserialize as deserializeOp, serialize as serializeOp } from './persistence'
import { search as searchOp } from './search'
import {
  DEFAULT_FILTER_THRESHOLD,
  DEFAULT_PROMOTION_THRESHOLD,
  liveSize,
  type MaintenanceStatus,
  type VectorIndexPayload,
  type VectorIndexState,
  type VectorScoredResult,
  type VectorSearchOptions,
} from './shared'

export type { MaintenanceStatus, VectorIndexPayload, VectorScoredResult, VectorSearchOptions } from './shared'

export interface VectorIndex {
  insert(docId: string, vector: Float32Array): void
  remove(docId: string): void
  scheduleBuild(): void
  awaitPendingBuild(): Promise<void>
  dispose(): void
  search(query: Float32Array, k: number, options: VectorSearchOptions): VectorScoredResult[]
  getVector(docId: string): Float32Array | null
  has(docId: string): boolean
  compact(): void
  optimize(): Promise<void>
  maintenanceStatus(): MaintenanceStatus
  estimateMemoryBytes(): number
  serialize(): VectorIndexPayload
  deserialize(payload: VectorIndexPayload): void

  readonly size: number
  readonly dimension: number
  readonly fieldName: string
}

export function createVectorIndex(fieldName: string, dimension: number, config?: VectorIndexConfig): VectorIndex {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new NarsilError(
      ErrorCodes.VECTOR_DIMENSION_MISMATCH,
      `Vector dimension must be a positive integer, got ${dimension}`,
      { dimension },
    )
  }

  const promotionThreshold = config?.threshold ?? DEFAULT_PROMOTION_THRESHOLD
  const filterThreshold = Math.max(0, Math.min(1, config?.filterThreshold ?? DEFAULT_FILTER_THRESHOLD))
  const quantizationMode = config?.quantization ?? 'sq8'
  const rawHnswM = config?.hnswConfig?.m
  const hnswConfig: HNSWConfig | undefined = config?.hnswConfig
    ? { ...config.hnswConfig, m: rawHnswM !== undefined ? Math.max(rawHnswM, 2) : undefined }
    : undefined
  const dimensionScale = dimension / 256

  const state: VectorIndexState = {
    fieldName,
    dimension,
    dimensionScale,
    promotionThreshold,
    filterThreshold,
    quantizationMode,
    hnswConfig,
    store: createVectorStore(),
    tombstones: new Set<string>(),
    buffer: new Set<string>(),
    sq8: quantizationMode === 'sq8' ? createScalarQuantizer(dimension) : null,
    hnsw: null,
    building: false,
    buildScheduled: false,
    pendingBuild: null,
    disposed: false,
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

  function insert(docId: string, vector: Float32Array): void {
    validateDimension(vector)
    state.tombstones.delete(docId)
    state.store.insert(docId, vector)
    state.buffer.add(docId)
  }

  function remove(docId: string): void {
    if (!state.store.has(docId)) return
    state.tombstones.add(docId)
    state.buffer.delete(docId)
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
    if (state.pendingBuild) {
      await state.pendingBuild
    }
  }

  function dispose(): void {
    state.disposed = true
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
    insert,
    remove,
    scheduleBuild: () => scheduleBuildOp(state),
    awaitPendingBuild,
    dispose,
    search: (query: Float32Array, k: number, options: VectorSearchOptions) => searchOp(state, query, k, options),
    getVector,
    has,
    compact: () => compactOp(state),
    optimize: () => optimizeOp(state),
    maintenanceStatus: () => maintenanceStatusOp(state),
    estimateMemoryBytes: () => estimateMemoryBytesOp(state),
    serialize: () => serializeOp(state),
    deserialize: (payload: VectorIndexPayload) => deserializeOp(state, payload),
  }
}
