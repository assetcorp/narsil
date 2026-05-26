import { beforeEach, describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../../vector/hnsw'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'
import { DIM, insertVec, randomVector, vectorFromValues } from './fixtures'

describe('HNSWIndex search (K-NN)', () => {
  let store: VectorStore
  let index: HNSWIndex

  beforeEach(() => {
    store = createVectorStore()
    index = createHNSWIndex(DIM, store, { m: 4, efConstruction: 32, metric: 'cosine' })
  })

  it('returns empty for empty index', () => {
    const query = randomVector(DIM)
    const results = index.search(query, 5, 'cosine', 0)
    expect(results).toHaveLength(0)
  })

  it('rejects query with wrong dimension', () => {
    insertVec(store, index, 'doc1', randomVector(DIM))
    expect(() => index.search(new Float32Array(DIM + 1), 5, 'cosine', 0)).toThrow(/dimension mismatch/)
  })

  it('finds the nearest vector (cosine)', () => {
    const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
    const near = vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0)
    const far = vectorFromValues(0, 0, 0, 0, 0, 0, 0, 1)

    insertVec(store, index, 'near', near)
    insertVec(store, index, 'far', far)

    const results = index.search(target, 1, 'cosine', 0)
    expect(results).toHaveLength(1)
    expect(results[0].docId).toBe('near')
  })

  it('returns at most k results', () => {
    for (let i = 0; i < 20; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const results = index.search(randomVector(DIM), 5, 'cosine', 0)
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('respects minSimilarity threshold', () => {
    const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
    const orthogonal = vectorFromValues(0, 1, 0, 0, 0, 0, 0, 0)
    const similar = vectorFromValues(0.95, 0.05, 0, 0, 0, 0, 0, 0)

    insertVec(store, index, 'orthogonal', orthogonal)
    insertVec(store, index, 'similar', similar)

    const results = index.search(target, 10, 'cosine', 0.9)
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.9)
    }
    expect(results.some(r => r.docId === 'similar')).toBe(true)
  })

  it('filters by docId set', () => {
    for (let i = 0; i < 20; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const allowed = new Set(['doc0', 'doc1', 'doc2'])
    const results = index.search(randomVector(DIM), 10, 'cosine', 0, allowed)

    for (const r of results) {
      expect(allowed.has(r.docId)).toBe(true)
    }
  })

  it('returns scores in descending order', () => {
    for (let i = 0; i < 30; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const results = index.search(randomVector(DIM), 10, 'cosine', 0)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
  })

  it('accepts efSearch parameter', () => {
    for (let i = 0; i < 30; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const resultsLowEf = index.search(randomVector(DIM), 5, 'cosine', 0, undefined, 5)
    const resultsHighEf = index.search(randomVector(DIM), 5, 'cosine', 0, undefined, 100)

    expect(resultsLowEf.length).toBeLessThanOrEqual(5)
    expect(resultsHighEf.length).toBeLessThanOrEqual(5)
  })
})
