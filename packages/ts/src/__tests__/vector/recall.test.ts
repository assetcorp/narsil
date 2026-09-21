import { describe, expect, it } from 'vitest'
import { createHNSWIndex } from '../../vector/hnsw'
import { createOsqQuantizer, type OsqBits } from '../../vector/osq'
import { createVectorStore } from '../../vector/vector-store'
import { createExactSearch } from './exact-search'

const CLUSTER_CENTRES = 64
const CLUSTER_SPREAD = 0.35

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function gaussianPair(random: () => number): [number, number] {
  let u = 0
  let v = 0
  let s = 0
  do {
    u = random() * 2 - 1
    v = random() * 2 - 1
    s = u * u + v * v
  } while (s === 0 || s >= 1)
  const factor = Math.sqrt((-2 * Math.log(s)) / s)
  return [u * factor, v * factor]
}

function gaussianVector(dim: number, random: () => number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i += 2) {
    const [a, b] = gaussianPair(random)
    v[i] = a
    if (i + 1 < dim) v[i + 1] = b
  }
  return v
}

function unitNormalise(v: Float32Array): Float32Array {
  let sumSq = 0
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i]
  const mag = Math.sqrt(sumSq)
  if (mag === 0) return v
  for (let i = 0; i < v.length; i++) v[i] /= mag
  return v
}

function clusteredVectors(dim: number, count: number, random: () => number): Float32Array[] {
  const centres = Array.from({ length: CLUSTER_CENTRES }, () => gaussianVector(dim, random))
  const vectors: Float32Array[] = []
  for (let n = 0; n < count; n++) {
    const centre = centres[Math.floor(random() * CLUSTER_CENTRES)]
    const noise = gaussianVector(dim, random)
    const v = new Float32Array(dim)
    for (let i = 0; i < dim; i++) v[i] = centre[i] + CLUSTER_SPREAD * noise[i]
    vectors.push(unitNormalise(v))
  }
  return vectors
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

function runRecallBenchmark(
  dim: number,
  bits: OsqBits,
  vectorCount: number,
  queryCount: number,
  k: number,
  efSearch: number,
  oversample?: number,
): number {
  const random = pseudoRandom(20260913 + dim + bits)
  const store = createVectorStore({ dimension: dim, codeBits: bits })
  const quantizer = createOsqQuantizer(dim, bits, 'cosine', store)
  const corpus = clusteredVectors(dim, vectorCount + queryCount, random)
  const docIds: string[] = []

  for (let i = 0; i < vectorCount; i++) {
    const docId = `doc${i}`
    docIds.push(docId)
    store.insert(docId, corpus[i])
  }

  quantizer.calibrate(Int32Array.from({ length: vectorCount }, (_, ordinal) => ordinal))

  const hnsw = createHNSWIndex(dim, store, { m: 16, efConstruction: 200, metric: 'cosine' }, quantizer)
  for (const docId of docIds) {
    hnsw.insertNode(docId)
  }

  const bruteForce = createExactSearch(dim, store)

  let totalRecall = 0
  for (let q = 0; q < queryCount; q++) {
    const query = corpus[vectorCount + q]
    const bfResults = bruteForce.search(query, k, 'cosine', 0)
    const hnswResults = hnsw.search(query, k, 'cosine', 0, { efSearch, oversample })

    const recall = computeRecallAtK(hnswResults, bfResults, k)
    totalRecall += recall
  }

  return totalRecall / queryCount
}

describe('HNSW built from OSQ codes, recall@10 on clustered vectors', () => {
  it('achieves >= 95% recall@10 with 2K vectors at 1536 dims and 1-bit codes', () => {
    const avgRecall = runRecallBenchmark(1536, 1, 2000, 100, 10, 128)
    expect(avgRecall).toBeGreaterThanOrEqual(0.95)
  }, 300_000)

  it('achieves >= 95% recall@10 with 2K vectors at 384 dims and 4-bit codes re-scored three deep', () => {
    const avgRecall = runRecallBenchmark(384, 4, 2000, 100, 10, 128, 3)
    expect(avgRecall).toBeGreaterThanOrEqual(0.95)
  }, 300_000)

  it('achieves >= 95% recall@10 with 2K vectors at 128 dims and 8-bit codes', () => {
    const avgRecall = runRecallBenchmark(128, 8, 2000, 100, 10, 128)
    expect(avgRecall).toBeGreaterThanOrEqual(0.95)
  }, 300_000)
})
