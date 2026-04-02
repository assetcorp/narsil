import { describe, expect, it } from 'vitest'
import { createBruteForceSearch } from '../../vector/brute-force'
import { createHNSWIndex } from '../../vector/hnsw'
import { createScalarQuantizer } from '../../vector/scalar-quantization'
import { magnitude } from '../../vector/similarity'
import { createVectorStore } from '../../vector/vector-store'

function normalizedVector(dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1
  }
  const mag = magnitude(v)
  if (mag === 0) return v
  for (let i = 0; i < dim; i++) {
    v[i] /= mag
  }
  return v
}

function computeRecallAtK(
  hnswResults: Array<{ docId: string }>,
  bruteForceResults: Array<{ docId: string }>,
  k: number,
): number {
  const hnswTopK = new Set(hnswResults.slice(0, k).map(r => r.docId))
  const bfTopK = new Set(bruteForceResults.slice(0, k).map(r => r.docId))
  let matches = 0
  for (const docId of bfTopK) {
    if (hnswTopK.has(docId)) matches++
  }
  return bfTopK.size > 0 ? matches / bfTopK.size : 1
}

function runRecallBenchmark(dim: number, vectorCount: number, queryCount: number, k: number, efSearch: number): number {
  const store = createVectorStore()
  const quantizer = createScalarQuantizer(dim)
  const vectors = new Map<string, Float32Array>()

  for (let i = 0; i < vectorCount; i++) {
    const v = normalizedVector(dim)
    const docId = `doc${i}`
    vectors.set(docId, v)
    store.insert(docId, v)
  }

  const allVectors = Array.from(vectors.values())
  quantizer.calibrate(allVectors)
  for (const [docId, v] of vectors) {
    quantizer.quantize(docId, v)
  }

  const m = dim >= 256 ? 48 : 16
  const hnsw = createHNSWIndex(dim, store, { m, efConstruction: 200, metric: 'cosine' }, quantizer)
  for (const docId of vectors.keys()) {
    hnsw.insertNode(docId)
  }

  const bruteForce = createBruteForceSearch(dim, store)

  let totalRecall = 0
  for (let q = 0; q < queryCount; q++) {
    const query = normalizedVector(dim)
    const bfResults = bruteForce.search(query, k, 'cosine', 0)
    const hnswResults = hnsw.search(query, k, 'cosine', 0, undefined, efSearch)

    const recall = computeRecallAtK(hnswResults, bfResults, k)
    totalRecall += recall
  }

  return totalRecall / queryCount
}

describe('HNSW + SQ8 recall@10', () => {
  it('achieves >= 95% recall@10 with 2K vectors at 1536 dims', () => {
    const avgRecall = runRecallBenchmark(1536, 2000, 50, 10, 75)
    expect(avgRecall).toBeGreaterThanOrEqual(0.95)
  }, 300_000)

  it('achieves >= 95% recall@10 with 2K vectors at 384 dims', () => {
    const avgRecall = runRecallBenchmark(384, 2000, 50, 10, 75)
    expect(avgRecall).toBeGreaterThanOrEqual(0.95)
  }, 300_000)
})
