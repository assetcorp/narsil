import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../vector/hnsw'
import { createScalarQuantizer } from '../../vector/scalar-quantization'
import { createVectorSearchPool, type VectorSearchPool } from '../../vector/search-pool'
import type { SharedVectorFieldHandles } from '../../vector/shared-field/types'
import { createVectorStore, type VectorStore } from '../../vector/vector-store'

const DIMENSION = 64
const DOC_COUNT = 1500
const RESULT_COUNT = 8
const WORKER_COUNT = 4
const CONCURRENT_ROUNDS = 6
const QUERIES_PER_ROUND = 12
const INSERT_CHUNK = 32
const RECALL_QUERIES = 40
const RECALL_FLOOR_AT_10 = 0.95

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function nextVector(next: () => number): Float32Array {
  const vector = new Float32Array(DIMENSION)
  for (let component = 0; component < DIMENSION; component++) {
    vector[component] = next() - 0.5
  }
  return vector
}

function docIdOf(index: number): string {
  return `doc-${String(index).padStart(5, '0')}`
}

function bruteForceTop(store: VectorStore, query: Float32Array, k: number): string[] {
  const prepared = store.prepareQueryArena(query)
  if (prepared === null) throw new Error('the store offers no arena')
  const best: Array<{ docId: string; distance: number }> = []
  for (const [docId] of store.entries()) {
    const ordinal = store.getOrdinal(docId)
    if (ordinal === undefined) continue
    const distance = store.distanceFromArena(prepared, ordinal, 'cosine')
    best.push({ docId, distance })
  }
  best.sort((a, b) => a.distance - b.distance)
  return best.slice(0, k).map(entry => entry.docId)
}

describe('real workers sharing one vector field in place', () => {
  let pool: VectorSearchPool | null = null
  let store: VectorStore
  let graph: HNSWIndex
  let handles: SharedVectorFieldHandles

  beforeAll(async () => {
    const next = pseudoRandom(20260810)
    store = createVectorStore({ dimension: DIMENSION, quantized: true })
    for (let i = 0; i < DOC_COUNT; i++) {
      store.insert(docIdOf(i), nextVector(next))
    }

    const quantizer = createScalarQuantizer(DIMENSION, store)
    const all: Float32Array[] = []
    for (const [, entry] of store.entries()) all.push(entry.vector)
    quantizer.calibrate(all)
    for (const [docId, entry] of store.entries()) quantizer.quantize(docId, entry.vector)

    graph = createHNSWIndex(DIMENSION, store, { m: 16, efConstruction: 100, metric: 'cosine' }, quantizer)
    handles = {
      dimension: DIMENSION,
      quantization: 'sq8',
      store: store.handles,
      graph: graph.handles,
      filterThreshold: 0.03,
      searchable: true,
    }

    pool = await createVectorSearchPool(WORKER_COUNT)
  }, 120_000)

  afterAll(async () => {
    await pool?.shutdown()
    pool = null
  })

  it('opens the field on every worker', async () => {
    expect(pool).not.toBeNull()
    if (pool === null) return
    await expect(pool.loadShared('field#1', handles)).resolves.toBe(true)
  }, 60_000)

  it('reaches the recall floor after every worker places vectors in one graph at once', async () => {
    if (pool === null) return
    const activePool = pool
    const chunks: Int32Array[] = []
    for (let start = 0; start < DOC_COUNT; start += INSERT_CHUNK) {
      const end = Math.min(DOC_COUNT, start + INSERT_CHUNK)
      chunks.push(Int32Array.from({ length: end - start }, (_, i) => start + i))
    }
    const outcomes = await Promise.all(chunks.map(chunk => activePool.insertOrdinals('field#1', chunk)))

    expect(outcomes.every(outcome => outcome !== null)).toBe(true)
    expect(graph.size).toBe(DOC_COUNT)

    const queryNext = pseudoRandom(7)
    let hits = 0
    for (let q = 0; q < RECALL_QUERIES; q++) {
      const query = nextVector(queryNext)
      const truth = new Set(bruteForceTop(store, query, 10))
      for (const result of graph.search(query, 10, 'cosine', -Infinity)) {
        if (truth.has(result.docId)) hits += 1
      }
    }
    expect(hits / (RECALL_QUERIES * 10)).toBeGreaterThanOrEqual(RECALL_FLOOR_AT_10)
  }, 120_000)

  it('answers concurrent queries from every worker exactly as the owning thread does', async () => {
    if (pool === null) return
    const activePool = pool
    for (let i = 0; i < DOC_COUNT; i += 9) graph.markTombstone(docIdOf(i))
    const queryNext = pseudoRandom(31)

    for (let round = 0; round < CONCURRENT_ROUNDS; round++) {
      const queries: Float32Array[] = []
      for (let q = 0; q < QUERIES_PER_ROUND; q++) queries.push(nextVector(queryNext))

      const remote = await Promise.all(
        queries.map(query => activePool.searchOrdinals('field#1', query, RESULT_COUNT, 'cosine', 0)),
      )

      for (let q = 0; q < queries.length; q++) {
        const local = graph.search(queries[q], RESULT_COUNT, 'cosine', 0)
        const mappedDocIds: Array<string | undefined> = []
        for (const ordinal of remote[q].ordinals) mappedDocIds.push(store.docIdForOrdinal(ordinal))

        expect(mappedDocIds).toEqual(local.map(result => result.docId))
        for (let position = 0; position < local.length; position++) {
          expect(Object.is(remote[q].scores[position], local[position].score)).toBe(true)
        }
      }
    }
  }, 120_000)

  it('refuses a document id search against a shared handle', async () => {
    if (pool === null) return
    await expect(pool.search('field#1', nextVector(pseudoRandom(1)), 3, 'cosine', 0)).rejects.toThrow(/field#1/)
  }, 60_000)
})
