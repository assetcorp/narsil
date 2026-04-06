import { createBoundedMaxHeap } from '../core/heap'
import { ErrorCodes, NarsilError } from '../errors'
import type { VectorIndexConfig } from '../types/schema'
import type { VectorMetric } from './brute-force'
import { createHNSWIndex, type HNSWConfig, type HNSWIndex, type SerializedHNSWGraph } from './hnsw'
import { dispatchWorkerBuild } from './hnsw-worker-dispatch'
import {
  createScalarQuantizer,
  deserializeScalarQuantizer,
  type ScalarQuantizer,
  type SerializedSQ8,
} from './scalar-quantization'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from './similarity'
import { createVectorStore } from './vector-store'

const DEFAULT_PROMOTION_THRESHOLD = 1024
const DEFAULT_FILTER_THRESHOLD = 0.03
const ESTIMATED_MS_PER_TOMBSTONE = 0.05
const ESTIMATED_MS_PER_VECTOR_REBUILD = 0.15
const WORKER_BUILD_SIZE_THRESHOLD = 5000

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

  const store = createVectorStore()
  const tombstones = new Set<string>()
  let sq8: ScalarQuantizer | null = quantizationMode === 'sq8' ? createScalarQuantizer(dimension) : null
  let hnsw: HNSWIndex | null = null
  const buffer = new Set<string>()
  let building = false
  let buildScheduled = false
  let pendingBuild: Promise<void> | null = null
  let disposed = false

  function liveSize(): number {
    return store.size - tombstones.size
  }

  function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
  }

  function mergeResults(
    hnswResults: VectorScoredResult[],
    bufferResults: VectorScoredResult[],
    k: number,
  ): VectorScoredResult[] {
    const seen = new Set<string>()
    const merged: VectorScoredResult[] = []
    let hi = 0
    let bi = 0

    while (merged.length < k && (hi < hnswResults.length || bi < bufferResults.length)) {
      const h = hi < hnswResults.length ? hnswResults[hi] : undefined
      const b = bi < bufferResults.length ? bufferResults[bi] : undefined

      let pick: VectorScoredResult
      if (h && b) {
        if (h.score > b.score || (h.score === b.score && h.docId.localeCompare(b.docId) < 0)) {
          pick = h
          hi++
        } else {
          pick = b
          bi++
        }
      } else if (h) {
        pick = h
        hi++
      } else if (b) {
        pick = b
        bi++
      } else {
        break
      }

      if (seen.has(pick.docId)) continue
      seen.add(pick.docId)
      merged.push(pick)
    }

    return merged
  }

  function validateDimension(vector: Float32Array): void {
    if (vector.length !== dimension) {
      throw new NarsilError(
        ErrorCodes.VECTOR_DIMENSION_MISMATCH,
        `Vector dimension mismatch: expected ${dimension}, got ${vector.length}`,
        { expected: dimension, received: vector.length },
      )
    }
  }

  function calibrateAndQuantizeAll(): void {
    if (!sq8) return
    if (store.size === 0) return

    function* vectorIterator(): Iterable<Float32Array> {
      for (const [docId, entry] of store.entries()) {
        if (tombstones.has(docId)) continue
        yield entry.vector
      }
    }

    sq8.calibrate(vectorIterator())

    for (const [docId, entry] of store.entries()) {
      if (tombstones.has(docId)) continue
      sq8.quantize(docId, entry.vector)
    }
  }

  function recalibrateFromStore(): void {
    if (!sq8) return
    function* storeVectors(): Iterable<[string, Float32Array]> {
      for (const [docId, entry] of store.entries()) {
        if (tombstones.has(docId)) continue
        yield [docId, entry.vector]
      }
    }
    sq8.recalibrateAll(storeVectors())
  }

  function triggerBuild(): void {
    if (building) return
    building = true

    const liveDocIds: string[] = []
    for (const [docId] of store.entries()) {
      if (tombstones.has(docId)) continue
      liveDocIds.push(docId)
    }

    const bufferSnapshot = new Set(buffer)

    const buildPromise = (async () => {
      try {
        if (liveDocIds.length === 0 || disposed) return

        if (sq8) {
          calibrateAndQuantizeAll()
        }

        if (liveDocIds.length > WORKER_BUILD_SIZE_THRESHOLD) {
          const workerResult = await tryWorkerBuild(liveDocIds, bufferSnapshot)
          if (workerResult) return
        }

        const newHnsw = createHNSWIndex(dimension, store, hnswConfig, sq8 ?? undefined)
        const CHUNK_SIZE = 100
        for (let i = 0; i < liveDocIds.length; i++) {
          const docId = liveDocIds[i]
          if (!store.has(docId) || tombstones.has(docId)) continue
          newHnsw.insertNode(docId)
          if ((i + 1) % CHUNK_SIZE === 0) {
            if (disposed) return
            await yieldToEventLoop()
          }
        }

        if (disposed) return

        hnsw = newHnsw

        for (const docId of tombstones) {
          if (newHnsw.has(docId)) {
            newHnsw.markTombstone(docId)
          }
        }

        for (const docId of bufferSnapshot) {
          buffer.delete(docId)
        }
      } finally {
        building = false
        pendingBuild = null
      }
    })()

    pendingBuild = buildPromise
  }

  async function tryWorkerBuild(liveDocIds: string[], bufferSnapshot: Set<string>): Promise<boolean> {
    const vectorData = new Float32Array(liveDocIds.length * dimension)
    const validDocIds: string[] = []
    let offset = 0

    for (const docId of liveDocIds) {
      const entry = store.get(docId)
      if (!entry || tombstones.has(docId)) continue
      vectorData.set(entry.vector, offset)
      validDocIds.push(docId)
      offset += dimension
    }

    if (validDocIds.length === 0) return false

    const packedData = offset < vectorData.length ? vectorData.subarray(0, offset) : vectorData

    const resolvedConfig: HNSWConfig = {
      m: hnswConfig?.m,
      efConstruction: hnswConfig?.efConstruction,
      metric: hnswConfig?.metric,
    }

    const timeoutMs = Math.max(10_000, liveDocIds.length * 2)
    const outcome = await dispatchWorkerBuild(validDocIds, packedData, dimension, resolvedConfig, timeoutMs, true)

    if (!outcome.ok) return false

    const newHnsw = createHNSWIndex(dimension, store, hnswConfig, sq8 ?? undefined)
    newHnsw.deserialize(outcome.graph)
    hnsw = newHnsw

    for (const docId of tombstones) {
      if (newHnsw.has(docId)) {
        newHnsw.markTombstone(docId)
      }
    }

    for (const docId of bufferSnapshot) {
      buffer.delete(docId)
    }

    return true
  }

  async function awaitPendingBuild(): Promise<void> {
    if (pendingBuild) {
      await pendingBuild
    }
  }

  function dispose(): void {
    disposed = true
  }

  function scheduleBuild(): void {
    if (building || buildScheduled || disposed) return

    const thresholdMet =
      (!hnsw && liveSize() >= promotionThreshold) || (hnsw !== null && buffer.size >= promotionThreshold)

    if (!thresholdMet) return

    buildScheduled = true
    setTimeout(() => {
      buildScheduled = false
      triggerBuild()
    }, 0)
  }

  function bruteForceSearch(
    query: Float32Array,
    k: number,
    metric: VectorMetric,
    minSimilarity: number,
    candidates: Iterable<string>,
  ): VectorScoredResult[] {
    const queryMag = magnitude(query)
    const highScoreFirst = (a: VectorScoredResult, b: VectorScoredResult) =>
      b.score - a.score || a.docId.localeCompare(b.docId)
    const heap = createBoundedMaxHeap<VectorScoredResult>(highScoreFirst, k)

    for (const docId of candidates) {
      if (tombstones.has(docId)) continue
      const entry = store.get(docId)
      if (!entry) continue

      let score: number
      switch (metric) {
        case 'cosine':
          score = cosineSimilarityWithMagnitudes(query, entry.vector, queryMag, entry.magnitude)
          break
        case 'dotProduct':
          score = dotProduct(query, entry.vector)
          break
        case 'euclidean': {
          const dist = euclideanDistance(query, entry.vector)
          score = 1 / (1 + dist)
          break
        }
      }

      if (score >= minSimilarity) {
        heap.push({ docId, score })
      }
    }

    return heap.toSortedArray().reverse()
  }

  function* allLiveDocIds(): Iterable<string> {
    for (const [docId] of store.entries()) {
      if (tombstones.has(docId)) continue
      yield docId
    }
  }

  /** Stores the vector; callers should call scheduleBuild() afterward if automatic HNSW build triggering is needed */
  function insert(docId: string, vector: Float32Array): void {
    validateDimension(vector)

    tombstones.delete(docId)
    store.insert(docId, vector)
    buffer.add(docId)
  }

  function remove(docId: string): void {
    if (!store.has(docId)) return

    tombstones.add(docId)
    buffer.delete(docId)

    if (hnsw) {
      hnsw.markTombstone(docId)
    }
  }

  function* bufferCandidates(filterDocIds?: Set<string>): Iterable<string> {
    if (filterDocIds) {
      if (buffer.size <= filterDocIds.size) {
        for (const docId of buffer) {
          if (filterDocIds.has(docId) && !tombstones.has(docId)) yield docId
        }
      } else {
        for (const docId of filterDocIds) {
          if (buffer.has(docId) && !tombstones.has(docId)) yield docId
        }
      }
    } else {
      for (const docId of buffer) {
        if (!tombstones.has(docId)) yield docId
      }
    }
  }

  function search(query: Float32Array, k: number, options: VectorSearchOptions): VectorScoredResult[] {
    validateDimension(query)

    const currentLiveSize = liveSize()
    if (currentLiveSize === 0) return []
    if (k <= 0) return []

    if (buffer.size > 0 && !building && !buildScheduled) {
      scheduleBuild()
    }

    const { metric, minSimilarity, filterDocIds, efSearch } = options

    if (filterDocIds && filterDocIds.size === 0) return []

    if (!hnsw) {
      const candidates = filterDocIds ?? allLiveDocIds()
      return bruteForceSearch(query, k, metric, minSimilarity, candidates)
    }

    if (buffer.size === 0) {
      if (filterDocIds) {
        const hnswLiveSize = hnsw.size
        const selectivity = hnswLiveSize > 0 ? filterDocIds.size / hnswLiveSize : 1
        if (selectivity < filterThreshold) {
          return bruteForceSearch(query, k, metric, minSimilarity, filterDocIds)
        }
      }

      const hnswResults = hnsw.search(query, k, metric, minSimilarity, filterDocIds, efSearch)
      return hnswResults.map(r => ({ docId: r.docId, score: r.score }))
    }

    if (filterDocIds) {
      const hnswLiveSize = hnsw.size
      const selectivity = hnswLiveSize > 0 ? filterDocIds.size / hnswLiveSize : 1
      if (selectivity < filterThreshold) {
        return bruteForceSearch(query, k, metric, minSimilarity, filterDocIds)
      }
    }

    const hnswResults = hnsw
      .search(query, k, metric, minSimilarity, filterDocIds, efSearch)
      .map(r => ({ docId: r.docId, score: r.score }))

    const bufferResults = bruteForceSearch(query, k, metric, minSimilarity, bufferCandidates(filterDocIds))

    return mergeResults(hnswResults, bufferResults, k)
  }

  function getVector(docId: string): Float32Array | null {
    if (tombstones.has(docId)) return null
    const entry = store.get(docId)
    if (!entry) return null
    return new Float32Array(entry.vector)
  }

  function has(docId: string): boolean {
    return store.has(docId) && !tombstones.has(docId)
  }

  function compact(): void {
    if (tombstones.size === 0) return

    if (hnsw) {
      hnsw.compactTombstones()
    }

    for (const docId of tombstones) {
      store.remove(docId)
      buffer.delete(docId)
      if (sq8) {
        sq8.remove(docId)
      }
    }

    tombstones.clear()

    if (sq8?.isCalibrated() && store.size > 0) {
      recalibrateFromStore()
    }
  }

  async function optimize(): Promise<void> {
    if (pendingBuild) {
      await pendingBuild
    }

    compact()

    const live = liveSize()
    if (live === 0) {
      if (hnsw) {
        hnsw.clear()
        hnsw = null
      }
      buffer.clear()
      if (sq8) {
        sq8.clear()
      }
      return
    }

    if (sq8) {
      calibrateAndQuantizeAll()
    }

    const newHnsw = createHNSWIndex(dimension, store, hnswConfig, sq8 ?? undefined)
    const liveDocIds: string[] = []
    for (const [docId] of store.entries()) {
      if (tombstones.has(docId)) continue
      liveDocIds.push(docId)
    }

    const CHUNK_SIZE = 100
    for (let i = 0; i < liveDocIds.length; i++) {
      newHnsw.insertNode(liveDocIds[i])
      if ((i + 1) % CHUNK_SIZE === 0) {
        await yieldToEventLoop()
      }
    }

    hnsw = newHnsw
    buffer.clear()

    if (sq8 && store.size > 0) {
      recalibrateFromStore()
    }
  }

  function maintenanceStatus(): MaintenanceStatus {
    const storeSize = store.size
    const tombstoneRatio = storeSize > 0 ? tombstones.size / storeSize : 0
    const graphCount = hnsw ? 1 : 0
    const estimatedCompactMs = Math.round(tombstones.size * ESTIMATED_MS_PER_TOMBSTONE * dimensionScale)
    const estimatedOptimizeMs = Math.round(storeSize * ESTIMATED_MS_PER_VECTOR_REBUILD * dimensionScale)

    return {
      tombstoneRatio,
      graphCount,
      bufferSize: buffer.size,
      building,
      estimatedCompactMs,
      estimatedOptimizeMs,
    }
  }

  function serialize(): VectorIndexPayload {
    const vectors: Array<{ docId: string; vector: number[] }> = []
    for (const [docId, entry] of store.entries()) {
      if (tombstones.has(docId)) continue
      vectors.push({ docId, vector: Array.from(entry.vector) })
    }

    const graphs: SerializedHNSWGraph[] = []
    if (hnsw) {
      graphs.push(hnsw.serialize())
    }

    let sq8Data: SerializedSQ8 | null = null
    if (sq8?.isCalibrated() && sq8.size > 0) {
      sq8Data = sq8.serialize()
    }

    return {
      fieldName,
      dimension,
      vectors,
      graphs,
      sq8: sq8Data,
    }
  }

  function deserialize(payload: VectorIndexPayload): void {
    if (payload.dimension !== dimension) {
      throw new NarsilError(
        ErrorCodes.VECTOR_DIMENSION_MISMATCH,
        `Payload dimension ${payload.dimension} does not match index dimension ${dimension}`,
        { expected: dimension, received: payload.dimension },
      )
    }

    for (const entry of payload.vectors) {
      if (entry.vector.length !== dimension) {
        throw new NarsilError(
          ErrorCodes.VECTOR_DIMENSION_MISMATCH,
          `Vector for doc "${entry.docId}" has dimension ${entry.vector.length}, expected ${dimension}`,
          { docId: entry.docId, expected: dimension, received: entry.vector.length },
        )
      }
    }

    store.clear()
    tombstones.clear()
    buffer.clear()
    if (hnsw) {
      hnsw.clear()
      hnsw = null
    }
    if (sq8) {
      sq8.clear()
    }

    for (const entry of payload.vectors) {
      store.insert(entry.docId, new Float32Array(entry.vector))
    }

    if (payload.sq8) {
      if (quantizationMode === 'sq8') {
        sq8 = deserializeScalarQuantizer(payload.sq8, dimension)
      }
    }

    if (payload.graphs.length > 0) {
      const graphData = payload.graphs[0]
      const restoredHnsw = createHNSWIndex(
        dimension,
        store,
        {
          m: graphData.m ?? hnswConfig?.m,
          efConstruction: graphData.efConstruction ?? hnswConfig?.efConstruction,
          metric: graphData.metric ?? hnswConfig?.metric,
        },
        sq8 ?? undefined,
      )
      restoredHnsw.deserialize(graphData)
      hnsw = restoredHnsw

      for (let i = 1; i < payload.graphs.length; i++) {
        const additionalGraph = payload.graphs[i]
        for (const [nodeDocId] of additionalGraph.nodes) {
          if (!restoredHnsw.has(nodeDocId) && store.has(nodeDocId)) {
            restoredHnsw.insertNode(nodeDocId)
          }
        }
      }

      for (const [docId] of store.entries()) {
        if (tombstones.has(docId)) continue
        if (!restoredHnsw.has(docId)) {
          buffer.add(docId)
        }
      }

      if (buffer.size > restoredHnsw.size) {
        hnsw.clear()
        hnsw = null
        buffer.clear()
        for (const [docId] of store.entries()) {
          if (tombstones.has(docId)) continue
          buffer.add(docId)
        }
      }
    } else {
      for (const [docId] of store.entries()) {
        if (tombstones.has(docId)) continue
        buffer.add(docId)
      }
    }
  }

  function estimateMemoryBytes(): number {
    const count = store.size
    if (count === 0 && tombstones.size === 0 && buffer.size === 0) return 0

    let bytes = store.estimateMemory(dimension)

    const TOMBSTONE_SET_OVERHEAD = 64
    const TOMBSTONE_ENTRY_COST = 72
    bytes += TOMBSTONE_SET_OVERHEAD + tombstones.size * TOMBSTONE_ENTRY_COST

    const BUFFER_SET_OVERHEAD = 64
    const BUFFER_ENTRY_COST = 72
    bytes += BUFFER_SET_OVERHEAD + buffer.size * BUFFER_ENTRY_COST

    if (hnsw) {
      const HNSW_NODE_OBJ = 48
      const MAP_ENTRY = 72
      const MAP_OVERHEAD = 64
      const CONN_ARRAY_HEADER = 32
      const SET_OVERHEAD = 64
      const SET_ENTRY_COST = 72

      const m = hnsw.m
      const avgLayers = m > 1 ? m / (m - 1) : 1
      const avgConnsLayer0 = m
      const avgConnsUpper = Math.ceil(m / 2)

      const connMemPerNode =
        CONN_ARRAY_HEADER +
        (SET_OVERHEAD + avgConnsLayer0 * SET_ENTRY_COST) +
        Math.max(0, avgLayers - 1) * (SET_OVERHEAD + avgConnsUpper * SET_ENTRY_COST)

      const hnswNodeCount = hnsw.size + hnsw.tombstoneCount
      const perHnswNode = MAP_ENTRY + HNSW_NODE_OBJ + connMemPerNode
      bytes += MAP_OVERHEAD + hnswNodeCount * perHnswNode
    }

    if (sq8?.isCalibrated()) {
      const sqCount = sq8.size
      const MAP_OVERHEAD_SQ = 64
      const MAP_ENTRY_SQ = 72
      const UINT8_ARRAY_HEADER = 64
      const PER_VECTOR_METADATA = 8 * 3
      const GLOBAL_CALIBRATION = 8 * 5

      bytes += 4 * (MAP_OVERHEAD_SQ + sqCount * MAP_ENTRY_SQ)
      bytes += sqCount * (UINT8_ARRAY_HEADER + dimension + PER_VECTOR_METADATA)
      bytes += GLOBAL_CALIBRATION
    }

    return Math.round(bytes)
  }

  return {
    get size() {
      return liveSize()
    },
    get dimension() {
      return dimension
    },
    get fieldName() {
      return fieldName
    },
    insert,
    remove,
    scheduleBuild,
    awaitPendingBuild,
    dispose,
    search,
    getVector,
    has,
    compact,
    optimize,
    maintenanceStatus,
    estimateMemoryBytes,
    serialize,
    deserialize,
  }
}
