import { describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import type { VectorQuantizationMode } from '../../types/schema'

const RECALL_FLOOR = 0.95
const K = 10
const QUERIES = 100
const PROMOTION_THRESHOLD = 100
const SETTLE_DEADLINE_MS = 240_000
const TEST_TIMEOUT_MS = 300_000
const INSERT_BATCH_DOCUMENTS = 500
const SPREAD_768_DIMENSION_SEED = 5

interface Clusters {
  centres: number
  spread: number
}

const TIGHT_CLUSTERS: Clusters = { centres: 64, spread: 0.35 }
const WIDE_CLUSTERS: Clusters = { centres: 40, spread: 0.6 }

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function gaussian(random: () => number): number {
  let u = 0
  let v = 0
  let s = 0
  do {
    u = random() * 2 - 1
    v = random() * 2 - 1
    s = u * u + v * v
  } while (s === 0 || s >= 1)
  return u * Math.sqrt((-2 * Math.log(s)) / s)
}

function unitLength(vector: number[]): number[] {
  const length = Math.hypot(...vector)
  return vector.map(value => Math.fround(value / length))
}

function clusteredVectors(dimension: number, count: number, clusters: Clusters, seed: number): number[][] {
  const random = seededRandom(seed)
  const centres = Array.from({ length: clusters.centres }, () =>
    Array.from({ length: dimension }, () => gaussian(random)),
  )
  return Array.from({ length: count }, () => {
    const centre = centres[Math.floor(random() * clusters.centres)]
    return unitLength(centre.map(value => value + clusters.spread * gaussian(random)))
  })
}

function exactNearest(query: number[], corpus: number[][]): Set<string> {
  const scored = corpus.map((vector, position) => {
    let dot = 0
    for (let i = 0; i < vector.length; i++) dot += vector[i] * query[i]
    return { id: `doc-${position}`, dot }
  })
  scored.sort((left, right) => right.dot - left.dot)
  return new Set(scored.slice(0, K).map(entry => entry.id))
}

async function recallOf(
  dimension: number,
  quantization: VectorQuantizationMode,
  documents: number,
  clusters: Clusters,
  search: { efSearch?: number; oversample?: number },
  queryCount = QUERIES,
  seed = 20260913 + dimension,
): Promise<number> {
  const all = clusteredVectors(dimension, documents + queryCount, clusters, seed)
  const corpus = all.slice(0, documents)
  const queries = all.slice(documents)
  const narsil = await createNarsil({ workers: { enabled: false } })
  try {
    await narsil.createIndex('articles', {
      schema: { embedding: `vector[${dimension}]` },
      vectorPromotion: { threshold: PROMOTION_THRESHOLD, quantization, hnswConfig: { m: 16, efConstruction: 200 } },
    })
    for (let start = 0; start < corpus.length; start += INSERT_BATCH_DOCUMENTS) {
      const batch = corpus.slice(start, start + INSERT_BATCH_DOCUMENTS)
      const result = await narsil.insertBatch(
        'articles',
        batch.map((embedding, offset) => ({ id: `doc-${start + offset}`, embedding })),
      )
      expect(result.failed).toEqual([])
    }
    const deadline = Date.now() + SETTLE_DEADLINE_MS
    while (
      narsil
        .vectorMaintenanceStatus('articles')
        .some(field => field.building || field.graphCount === 0 || field.bufferSize > 0)
    ) {
      if (Date.now() > deadline) throw new Error('the graph was still building at the deadline')
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    let found = 0
    for (const query of queries) {
      const result = await narsil.query('articles', {
        mode: 'vector',
        limit: K,
        vector: { field: 'embedding', value: query, ...search },
      })
      const truth = exactNearest(query, corpus)
      found += result.hits.filter(hit => truth.has(hit.id)).length
    }
    return found / (K * queries.length)
  } finally {
    await narsil.shutdown()
  }
}

describe('a vector search through the public API, measured against an exact search', () => {
  it(
    'finds at least 95% of the 10 nearest in 2,000 documents at 1,536 dimensions under osq1',
    async () => {
      const recall = await recallOf(1536, 'osq1', 2_000, TIGHT_CLUSTERS, { efSearch: 128 })
      expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'finds at least 95% of the 10 nearest in 2,000 documents at 384 dimensions under osq4',
    async () => {
      const recall = await recallOf(384, 'osq4', 2_000, TIGHT_CLUSTERS, { efSearch: 128, oversample: 3 })
      expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'finds at least 95% of the 10 nearest in 5,000 spread documents under osq1 at the default settings',
    async () => {
      const recall = await recallOf(384, 'osq1', 5_000, WIDE_CLUSTERS, {})
      expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'finds at least 95% of the 10 nearest in 5,000 spread documents under osq2 at the default settings',
    async () => {
      const recall = await recallOf(384, 'osq2', 5_000, WIDE_CLUSTERS, {})
      expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'finds at least 95% of the 10 nearest for 1,000 queries in 3,200 spread documents at 768 dimensions under osq2 at the default settings',
    async () => {
      const recall = await recallOf(768, 'osq2', 3_200, WIDE_CLUSTERS, {}, 1_000, SPREAD_768_DIMENSION_SEED)
      expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'finds at least 95% of the 10 nearest in 2,000 documents at 128 dimensions under osq8',
    async () => {
      const recall = await recallOf(128, 'osq8', 2_000, TIGHT_CLUSTERS, { efSearch: 128 })
      expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR)
    },
    TEST_TIMEOUT_MS,
  )
})
