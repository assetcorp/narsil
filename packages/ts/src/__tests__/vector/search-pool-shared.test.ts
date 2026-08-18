import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../vector/hnsw'
import { createScalarQuantizer } from '../../vector/scalar-quantization'
import { createVectorSearchPool, type VectorSearchPool } from '../../vector/search-pool'
import { freezeSharedGeneration } from '../../vector/shared-generation/freeze'
import type { SharedGenerationSnapshot } from '../../vector/shared-generation/types'
import { createVectorStore, type VectorStore } from '../../vector/vector-store'

const DIMENSION = 64
const DOC_COUNT = 1500
const RESULT_COUNT = 8
const WORKER_COUNT = 4
const CONCURRENT_ROUNDS = 6
const QUERIES_PER_ROUND = 12

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

describe('real workers searching one shared copy', () => {
  let pool: VectorSearchPool | null = null
  let store: VectorStore
  let graph: HNSWIndex
  let snapshot: SharedGenerationSnapshot | null = null

  beforeAll(async () => {
    const next = pseudoRandom(20260810)
    store = createVectorStore()
    for (let i = 0; i < DOC_COUNT; i++) {
      store.insert(`doc-${String(i).padStart(5, '0')}`, nextVector(next))
    }

    const quantizer = createScalarQuantizer(DIMENSION, store)
    const all: Float32Array[] = []
    for (const [, entry] of store.entries()) all.push(entry.vector)
    quantizer.calibrate(all)
    for (const [docId, entry] of store.entries()) quantizer.quantize(docId, entry.vector)

    graph = createHNSWIndex(DIMENSION, store, { m: 16, efConstruction: 100, metric: 'cosine' }, quantizer)
    for (const [docId] of store.entries()) graph.insertNode(docId)
    for (let i = 0; i < DOC_COUNT; i += 9) graph.markTombstone(`doc-${String(i).padStart(5, '0')}`)

    pool = await createVectorSearchPool(WORKER_COUNT)
    if (pool === null) return

    snapshot = freezeSharedGeneration(
      { dimension: DIMENSION, store, hnsw: graph, quantizer, quantization: 'sq8' },
      pool.scratchSlotCount,
    )
  }, 120_000)

  afterAll(async () => {
    await pool?.shutdown()
    pool = null
  })

  it('loads the frozen copy into every worker', async () => {
    expect(pool).not.toBeNull()
    expect(snapshot).not.toBeNull()
    if (pool === null || snapshot === null) return
    await expect(pool.loadShared('field#1', snapshot)).resolves.toBe(true)
  }, 60_000)

  it('answers concurrent queries from every worker exactly as the owning thread does', async () => {
    if (pool === null || snapshot === null) return
    const activePool = pool
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
    if (pool === null || snapshot === null) return
    await expect(pool.search('field#1', nextVector(pseudoRandom(1)), 3, 'cosine', 0)).rejects.toThrow(/field#1/)
  }, 60_000)
})
