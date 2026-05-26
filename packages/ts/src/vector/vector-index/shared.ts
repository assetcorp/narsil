import type { VectorMetric } from '../brute-force'
import type { HNSWConfig, HNSWIndex, SerializedHNSWGraph } from '../hnsw'
import type { ScalarQuantizer, SerializedSQ8 } from '../scalar-quantization'
import type { VectorStore } from '../vector-store'

export const DEFAULT_PROMOTION_THRESHOLD = 1024
export const DEFAULT_FILTER_THRESHOLD = 0.03
export const ESTIMATED_MS_PER_TOMBSTONE = 0.05
export const ESTIMATED_MS_PER_VECTOR_REBUILD = 0.15
export const WORKER_BUILD_SIZE_THRESHOLD = 5000

export interface VectorScoredResult {
  docId: string
  score: number
}

export interface VectorSearchOptions {
  metric: VectorMetric
  minSimilarity: number
  filterDocIds?: Set<string>
  efSearch?: number
}

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
  readonly store: VectorStore
  readonly tombstones: Set<string>
  readonly buffer: Set<string>
  sq8: ScalarQuantizer | null
  hnsw: HNSWIndex | null
  building: boolean
  buildScheduled: boolean
  pendingBuild: Promise<void> | null
  disposed: boolean
}

export function liveSize(state: VectorIndexState): number {
  return state.store.size - state.tombstones.size
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
