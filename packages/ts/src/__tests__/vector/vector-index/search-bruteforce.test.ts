import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, vectorFromValues } from './fixtures'

vi.mock('../../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

describe('VectorIndex search (brute-force only, no HNSW)', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  it('search with cosine metric returns results sorted by similarity', () => {
    index.insert('near', vectorFromValues(0.9, 0.1, 0, 0))
    index.insert('far', vectorFromValues(0, 0, 0, 1))

    const results = index.search(vectorFromValues(1, 0, 0, 0), 2, {
      metric: 'cosine',
      minSimilarity: 0,
    })

    expect(results.length).toBe(2)
    expect(results[0].docId).toBe('near')
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })

  it('search with dotProduct metric works', () => {
    index.insert('high', vectorFromValues(10, 0, 0, 0))
    index.insert('low', vectorFromValues(0, 10, 0, 0))

    const results = index.search(vectorFromValues(1, 0, 0, 0), 2, {
      metric: 'dotProduct',
      minSimilarity: -Infinity,
    })

    expect(results.length).toBe(2)
    expect(results[0].docId).toBe('high')
  })

  it('search with euclidean metric works', () => {
    index.insert('close', vectorFromValues(1.1, 0.1, 0, 0))
    index.insert('distant', vectorFromValues(5, 5, 5, 5))

    const results = index.search(vectorFromValues(1, 0, 0, 0), 2, {
      metric: 'euclidean',
      minSimilarity: 0,
    })

    expect(results.length).toBe(2)
    expect(results[0].docId).toBe('close')
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })

  it('search with k=0 returns empty', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))

    const results = index.search(vectorFromValues(1, 0, 0, 0), 0, {
      metric: 'cosine',
      minSimilarity: 0,
    })

    expect(results).toHaveLength(0)
  })

  it('search with empty index returns empty', () => {
    const results = index.search(vectorFromValues(1, 0, 0, 0), 5, {
      metric: 'cosine',
      minSimilarity: 0,
    })

    expect(results).toHaveLength(0)
  })

  it('search with minSimilarity filters low-scoring results', () => {
    index.insert('aligned', vectorFromValues(0.95, 0.05, 0, 0))
    index.insert('orthogonal', vectorFromValues(0, 1, 0, 0))

    const results = index.search(vectorFromValues(1, 0, 0, 0), 10, {
      metric: 'cosine',
      minSimilarity: 0.9,
    })

    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.9)
    }
    expect(results.some(r => r.docId === 'orthogonal')).toBe(false)
  })

  it('search with filterDocIds restricts candidates', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    index.insert('doc2', vectorFromValues(0, 1, 0, 0))
    index.insert('doc3', vectorFromValues(0, 0, 1, 0))

    const results = index.search(vectorFromValues(1, 0, 0, 0), 10, {
      metric: 'cosine',
      minSimilarity: 0,
      filterDocIds: new Set(['doc1', 'doc3']),
    })

    const docIds = results.map(r => r.docId)
    expect(docIds).toContain('doc1')
    expect(docIds).not.toContain('doc2')
  })

  it('search with empty filterDocIds returns empty', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))

    const results = index.search(vectorFromValues(1, 0, 0, 0), 10, {
      metric: 'cosine',
      minSimilarity: 0,
      filterDocIds: new Set<string>(),
    })

    expect(results).toHaveLength(0)
  })

  it('search excludes tombstoned documents', () => {
    index.insert('keep', vectorFromValues(0.9, 0.1, 0, 0))
    index.insert('removed', vectorFromValues(0.95, 0.05, 0, 0))
    index.remove('removed')

    const results = index.search(vectorFromValues(1, 0, 0, 0), 10, {
      metric: 'cosine',
      minSimilarity: 0,
    })

    expect(results.every(r => r.docId !== 'removed')).toBe(true)
    expect(results.some(r => r.docId === 'keep')).toBe(true)
  })
})
