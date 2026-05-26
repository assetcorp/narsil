import { beforeEach, describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../../vector/hnsw'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'
import { DIM, insertVec, randomVector, removeVec, vectorFromValues } from './fixtures'

describe('HNSWIndex edge cases', () => {
  let store: VectorStore
  let index: HNSWIndex

  beforeEach(() => {
    store = createVectorStore()
    index = createHNSWIndex(DIM, store, { m: 4, efConstruction: 32, metric: 'cosine' })
  })

  it('handles a single vector', () => {
    insertVec(store, index, 'only', vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0))

    const results = index.search(vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0), 1, 'cosine', 0)
    expect(results).toHaveLength(1)
    expect(results[0].docId).toBe('only')
    expect(results[0].score).toBeCloseTo(1, 5)
  })

  it('handles k larger than index size', () => {
    insertVec(store, index, 'doc1', randomVector(DIM))
    insertVec(store, index, 'doc2', randomVector(DIM))

    const results = index.search(randomVector(DIM), 100, 'cosine', 0)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('handles insert after clear', () => {
    insertVec(store, index, 'doc1', randomVector(DIM))
    index.clear()
    store.clear()
    insertVec(store, index, 'doc2', randomVector(DIM))

    expect(index.size).toBe(1)
    expect(index.has('doc2')).toBe(true)
    expect(index.has('doc1')).toBe(false)
  })

  it('handles mixed insert and remove operations', () => {
    for (let i = 0; i < 10; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }
    removeVec(store, index, 'doc3')
    removeVec(store, index, 'doc7')
    insertVec(store, index, 'doc_new', randomVector(DIM))

    expect(index.size).toBe(9)
    expect(index.has('doc3')).toBe(false)
    expect(index.has('doc7')).toBe(false)
    expect(index.has('doc_new')).toBe(true)

    const results = index.search(randomVector(DIM), 9, 'cosine', 0)
    const resultIds = new Set(results.map(r => r.docId))
    expect(resultIds.has('doc3')).toBe(false)
    expect(resultIds.has('doc7')).toBe(false)
  })

  it('handles zero vectors gracefully', () => {
    const zeroVec = new Float32Array(DIM)
    insertVec(store, index, 'zero', zeroVec)
    insertVec(store, index, 'nonzero', vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0))

    const results = index.search(vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0), 2, 'cosine', 0)
    expect(results.length).toBeGreaterThan(0)
  })

  it('filterDocIds with empty set returns no results', () => {
    for (let i = 0; i < 10; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const results = index.search(randomVector(DIM), 5, 'cosine', 0, new Set())
    expect(results).toHaveLength(0)
  })
})
