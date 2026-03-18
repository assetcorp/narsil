import type { ScoredDocument, VectorEntry } from '../types/internal'
import { type BruteForceVectorStore, createBruteForceVectorStore, type VectorMetric } from '../vector/brute-force'
import { createHNSWIndex, type HNSWConfig, type HNSWIndex, type SerializedHNSWGraph } from '../vector/hnsw'

export interface VectorSearchEngine {
  readonly dimension: number
  readonly size: number
  readonly isPromoted: boolean

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
  getBruteForceStore(): BruteForceVectorStore

  estimateMemoryBytes(): number

  serializeHNSW(): SerializedHNSWGraph | null
  deserializeHNSW(data: SerializedHNSWGraph): void
}

export function createVectorSearchEngine(dimension: number, defaultHNSWConfig?: HNSWConfig): VectorSearchEngine {
  const bruteForce = createBruteForceVectorStore(dimension)
  const hnswConfig = defaultHNSWConfig
  let hnsw: HNSWIndex | null = null

  return {
    get dimension() {
      return dimension
    },

    get size() {
      return bruteForce.size
    },

    get isPromoted() {
      return hnsw !== null
    },

    insert(docId: string, vector: Float32Array): void {
      bruteForce.insert(docId, vector)
      if (hnsw) {
        hnsw.insert(docId, vector)
      }
    },

    remove(docId: string): void {
      bruteForce.remove(docId)
      if (hnsw) {
        hnsw.remove(docId)
      }
    },

    has(docId: string): boolean {
      return bruteForce.has(docId)
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
      bruteForce.clear()
      if (hnsw) {
        hnsw.clear()
        hnsw = null
      }
    },

    entries(): IterableIterator<[string, VectorEntry]> {
      return bruteForce.entries()
    },

    promoteToHNSW(overrideConfig?: HNSWConfig): void {
      const cfg = overrideConfig ?? hnswConfig
      const newHnsw = createHNSWIndex(dimension, cfg)
      for (const [, entry] of bruteForce.entries()) {
        newHnsw.insert(entry.docId, entry.vector)
      }
      hnsw = newHnsw
    },

    demoteToLinear(): void {
      if (hnsw) {
        hnsw.clear()
        hnsw = null
      }
    },

    getHNSWIndex(): HNSWIndex | null {
      return hnsw
    },

    getBruteForceStore(): BruteForceVectorStore {
      return bruteForce
    },

    estimateMemoryBytes(): number {
      const count = bruteForce.size
      if (count === 0) return 0

      const MAP_OVERHEAD = 64
      const MAP_ENTRY = 72
      const VECTOR_ENTRY_OBJ = 32
      const AVG_DOCID_BYTES = 56
      const TYPED_ARRAY_HEADER = 64
      const MAGNITUDE_BYTES = 8

      const perBruteForceEntry = MAP_ENTRY + VECTOR_ENTRY_OBJ + AVG_DOCID_BYTES + TYPED_ARRAY_HEADER + MAGNITUDE_BYTES
      let bytes = MAP_OVERHEAD + count * (perBruteForceEntry + dimension * 4)

      if (hnsw) {
        const HNSW_NODE_OBJ = 64
        const SHARED_REFS = 16
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

        const perHnswNode = MAP_ENTRY + HNSW_NODE_OBJ + SHARED_REFS + connMemPerNode
        bytes += MAP_OVERHEAD + count * perHnswNode
      }

      return Math.round(bytes)
    },

    serializeHNSW(): SerializedHNSWGraph | null {
      if (!hnsw) return null
      return hnsw.serialize()
    },

    deserializeHNSW(data: SerializedHNSWGraph): void {
      const cfg = hnswConfig ?? {}
      const restoredHnsw = createHNSWIndex(dimension, {
        m: data.m ?? cfg.m,
        efConstruction: data.efConstruction ?? cfg.efConstruction,
        metric: data.metric ?? cfg.metric,
      })
      const vectorMap = new Map<string, { vector: Float32Array; mag: number }>()
      for (const [, entry] of bruteForce.entries()) {
        vectorMap.set(entry.docId, { vector: entry.vector, mag: entry.magnitude })
      }
      restoredHnsw.deserialize(data, vectorMap)
      hnsw = restoredHnsw
    },
  }
}
