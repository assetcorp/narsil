import type { ScoredDocument, VectorEntry } from '../types/internal'
import type { VectorIndexConfig } from '../types/schema'
import { createBruteForceSearch, type VectorMetric } from '../vector/brute-force'
import { createHNSWIndex, type HNSWConfig, type HNSWIndex, type SerializedHNSWGraph } from '../vector/hnsw'
import {
  createScalarQuantizer,
  deserializeScalarQuantizer,
  type ScalarQuantizer,
  type SerializedSQ8,
} from '../vector/scalar-quantization'
import { createVectorStore, type VectorStore } from '../vector/vector-store'

const DEFAULT_PROMOTION_THRESHOLD = 1024

export interface VectorSearchEngine {
  readonly dimension: number
  readonly size: number
  readonly isPromoted: boolean
  readonly compactionPending: boolean

  insert(docId: string, vector: Float32Array): void
  remove(docId: string): void
  has(docId: string): boolean
  search(
    query: Float32Array,
    k: number,
    metric: VectorMetric,
    minSimilarity: number,
    filterDocIds?: Set<string>,
    efSearch?: number,
  ): ScoredDocument[]
  clear(): void
  entries(): IterableIterator<[string, VectorEntry]>

  promoteToHNSW(hnswConfig?: HNSWConfig): void
  demoteToLinear(): void
  getHNSWIndex(): HNSWIndex | null
  getVectorStore(): VectorStore
  compact(): void

  estimateMemoryBytes(): number

  serializeHNSW(): SerializedHNSWGraph | null
  deserializeHNSW(data: SerializedHNSWGraph): void
  serializeSQ8(): SerializedSQ8 | null
  deserializeSQ8(data: SerializedSQ8): void
}

export function createVectorSearchEngine(
  dimension: number,
  defaultHNSWConfig?: HNSWConfig,
  indexConfig?: VectorIndexConfig,
): VectorSearchEngine {
  const store = createVectorStore()
  const bruteForce = createBruteForceSearch(dimension, store)
  const hnswConfig = defaultHNSWConfig
  const promotionThreshold = indexConfig?.threshold ?? DEFAULT_PROMOTION_THRESHOLD
  const mergedHnswConfig = indexConfig?.hnswConfig ?? hnswConfig
  const quantizationMode = indexConfig?.quantization ?? 'sq8'
  let sq8: ScalarQuantizer | null = quantizationMode === 'sq8' ? createScalarQuantizer(dimension) : null
  let hnsw: HNSWIndex | null = null
  let pendingCompaction = false

  function checkAutoPromotion(): void {
    if (hnsw) return
    if (store.size < promotionThreshold) return
    buildHNSWIndex(mergedHnswConfig)
  }

  function calibrateAndQuantizeAll(): void {
    if (!sq8) return
    if (store.size === 0) return

    function* vectorIterator(): Iterable<Float32Array> {
      for (const [, entry] of store.entries()) {
        yield entry.vector
      }
    }

    sq8.calibrate(vectorIterator())

    for (const [docId, entry] of store.entries()) {
      sq8.quantize(docId, entry.vector)
    }
  }

  function buildHNSWIndex(overrideConfig?: HNSWConfig): void {
    const cfg = overrideConfig ?? mergedHnswConfig

    if (sq8 && store.size > 0) {
      calibrateAndQuantizeAll()
    }

    const newHnsw = createHNSWIndex(dimension, store, cfg, sq8 ?? undefined)
    for (const [docId] of store.entries()) {
      newHnsw.insertNode(docId)
    }
    hnsw = newHnsw
  }

  function recalibrateFromStore(): void {
    if (!sq8) return
    function* storeVectors(): Iterable<[string, Float32Array]> {
      for (const [docId, entry] of store.entries()) {
        yield [docId, entry.vector]
      }
    }
    sq8.recalibrateAll(storeVectors())
  }

  return {
    get dimension() {
      return dimension
    },

    get size() {
      return store.size
    },

    get isPromoted() {
      return hnsw !== null
    },

    get compactionPending() {
      return pendingCompaction
    },

    insert(docId: string, vector: Float32Array): void {
      if (vector.length !== dimension) {
        throw new Error(`Vector dimension mismatch: expected ${dimension}, got ${vector.length}`)
      }
      store.insert(docId, vector)
      if (sq8?.isCalibrated()) {
        if (sq8.needsRecalibration(vector)) {
          recalibrateFromStore()
        } else {
          sq8.quantize(docId, vector)
        }
      }
      if (hnsw) {
        hnsw.insertNode(docId)
      } else {
        checkAutoPromotion()
      }
    },

    remove(docId: string): void {
      if (hnsw) {
        hnsw.markTombstone(docId)
        if (hnsw.compactionNeeded()) {
          pendingCompaction = true
        }
      }
      if (sq8) {
        sq8.remove(docId)
      }
      store.remove(docId)
    },

    has(docId: string): boolean {
      return store.has(docId)
    },

    search(
      query: Float32Array,
      k: number,
      metric: VectorMetric,
      minSimilarity: number,
      filterDocIds?: Set<string>,
      efSearch?: number,
    ): ScoredDocument[] {
      if (hnsw) {
        return hnsw.search(query, k, metric, minSimilarity, filterDocIds, efSearch)
      }
      return bruteForce.search(query, k, metric, minSimilarity, filterDocIds)
    },

    clear(): void {
      store.clear()
      if (hnsw) {
        hnsw.clear()
        hnsw = null
      }
      if (sq8) {
        sq8.clear()
      }
    },

    entries(): IterableIterator<[string, VectorEntry]> {
      return storeToVectorEntries(store)
    },

    promoteToHNSW(overrideConfig?: HNSWConfig): void {
      buildHNSWIndex(overrideConfig)
    },

    demoteToLinear(): void {
      if (hnsw) {
        hnsw.clear()
        hnsw = null
      }
      if (sq8) {
        sq8.clear()
      }
    },

    getHNSWIndex(): HNSWIndex | null {
      return hnsw
    },

    getVectorStore(): VectorStore {
      return store
    },

    compact(): void {
      if (hnsw) {
        hnsw.compact()
        pendingCompaction = false
      }
      if (sq8) {
        recalibrateFromStore()
      }
    },

    estimateMemoryBytes(): number {
      let bytes = store.estimateMemory(dimension)

      if (hnsw) {
        const count = store.size
        const HNSW_NODE_OBJ = 48
        const MAP_ENTRY = 72
        const MAP_OVERHEAD = 64
        const CONN_ARRAY_HEADER = 32
        const SET_OVERHEAD = 64
        const SET_ENTRY_COST = 72

        const m = hnsw.m
        const avgLayers = m / (m - 1)
        const avgConnsLayer0 = m
        const avgConnsUpper = Math.ceil(m / 2)

        const connMemPerNode =
          CONN_ARRAY_HEADER +
          (SET_OVERHEAD + avgConnsLayer0 * SET_ENTRY_COST) +
          Math.max(0, avgLayers - 1) * (SET_OVERHEAD + avgConnsUpper * SET_ENTRY_COST)

        const perHnswNode = MAP_ENTRY + HNSW_NODE_OBJ + connMemPerNode
        bytes += MAP_OVERHEAD + count * perHnswNode
      }

      if (sq8?.isCalibrated()) {
        const count = sq8.size
        const MAP_OVERHEAD_SQ = 64
        const MAP_ENTRY_SQ = 72
        const UINT8_ARRAY_HEADER = 64
        const PER_VECTOR_METADATA = 8 * 3
        const GLOBAL_CALIBRATION = 8 * 5

        bytes += 4 * (MAP_OVERHEAD_SQ + count * MAP_ENTRY_SQ)
        bytes += count * (UINT8_ARRAY_HEADER + dimension + PER_VECTOR_METADATA)
        bytes += GLOBAL_CALIBRATION
      }

      return Math.round(bytes)
    },

    serializeHNSW(): SerializedHNSWGraph | null {
      if (!hnsw) return null
      return hnsw.serialize()
    },

    deserializeHNSW(data: SerializedHNSWGraph): void {
      const cfg = mergedHnswConfig ?? {}
      const restoredHnsw = createHNSWIndex(
        dimension,
        store,
        {
          m: data.m ?? cfg.m,
          efConstruction: data.efConstruction ?? cfg.efConstruction,
          metric: data.metric ?? cfg.metric,
        },
        sq8 ?? undefined,
      )
      restoredHnsw.deserialize(data)
      hnsw = restoredHnsw
    },

    serializeSQ8(): SerializedSQ8 | null {
      if (!sq8 || !sq8.isCalibrated() || sq8.size === 0) return null
      return sq8.serialize()
    },

    deserializeSQ8(data: SerializedSQ8): void {
      if (quantizationMode === 'none') return
      sq8 = deserializeScalarQuantizer(data, dimension)
    },
  }
}

function* storeToVectorEntries(store: VectorStore): IterableIterator<[string, VectorEntry]> {
  for (const [docId, entry] of store.entries()) {
    yield [docId, { docId, vector: entry.vector, magnitude: entry.magnitude }]
  }
}
