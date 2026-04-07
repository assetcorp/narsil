import { describe, expect, it } from 'vitest'
import { createBruteForceSearch } from '../../vector/brute-force'
import { magnitude } from '../../vector/similarity'
import { createVectorStore, type VectorStore } from '../../vector/vector-store'

function vectorFromValues(...values: number[]): Float32Array {
  return new Float32Array(values)
}

function normalizedVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
  }
  const mag = magnitude(v)
  if (mag > 0) {
    for (let i = 0; i < dim; i++) {
      v[i] /= mag
    }
  }
  return v
}

function populateStore(store: VectorStore, dim: number, count: number): void {
  for (let i = 0; i < count; i++) {
    store.insert(`doc${i}`, normalizedVector(dim, i + 1))
  }
}

describe('BruteForceSearch', () => {
  const DIM = 8

  describe('cosine metric', () => {
    it('returns results sorted by score descending', () => {
      const store = createVectorStore()
      populateStore(store, DIM, 20)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(normalizedVector(DIM, 42), 10, 'cosine', -1)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    it('returns correct number of results respecting k', () => {
      const store = createVectorStore()
      populateStore(store, DIM, 20)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(normalizedVector(DIM, 42), 5, 'cosine', -1)
      expect(results).toHaveLength(5)
    })

    it('produces correct ranking for known vectors', () => {
      const store = createVectorStore()
      const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const near = vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0)
      const far = vectorFromValues(0, 0, 0, 0, 0, 0, 0, 1)

      store.insert('near', near)
      store.insert('far', far)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(query, 2, 'cosine', -1)
      expect(results[0].docId).toBe('near')
      expect(results[1].docId).toBe('far')
    })
  })

  describe('dotProduct metric', () => {
    it('returns results sorted by score descending', () => {
      const store = createVectorStore()
      populateStore(store, DIM, 20)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(normalizedVector(DIM, 42), 10, 'dotProduct', -Infinity)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    it('returns correct number of results respecting k', () => {
      const store = createVectorStore()
      populateStore(store, DIM, 20)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(normalizedVector(DIM, 42), 7, 'dotProduct', -Infinity)
      expect(results).toHaveLength(7)
    })

    it('produces correct ranking for known vectors', () => {
      const store = createVectorStore()
      const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const highDp = vectorFromValues(10, 0, 0, 0, 0, 0, 0, 0)
      const lowDp = vectorFromValues(0, 10, 0, 0, 0, 0, 0, 0)

      store.insert('highDp', highDp)
      store.insert('lowDp', lowDp)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(query, 2, 'dotProduct', -Infinity)
      expect(results[0].docId).toBe('highDp')
    })
  })

  describe('euclidean metric', () => {
    it('returns results sorted by score descending', () => {
      const store = createVectorStore()
      populateStore(store, DIM, 20)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(normalizedVector(DIM, 42), 10, 'euclidean', 0)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    it('returns correct number of results respecting k', () => {
      const store = createVectorStore()
      populateStore(store, DIM, 20)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(normalizedVector(DIM, 42), 3, 'euclidean', 0)
      expect(results).toHaveLength(3)
    })

    it('produces correct ranking for known vectors', () => {
      const store = createVectorStore()
      const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const near = vectorFromValues(1.1, 0.1, 0, 0, 0, 0, 0, 0)
      const far = vectorFromValues(5, 5, 5, 5, 5, 5, 5, 5)

      store.insert('near', near)
      store.insert('far', far)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(query, 2, 'euclidean', 0)
      expect(results[0].docId).toBe('near')
      expect(results[0].score).toBeGreaterThan(results[1].score)
    })
  })

  describe('edge cases', () => {
    it('k=0 returns empty array', () => {
      const store = createVectorStore()
      populateStore(store, DIM, 10)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(normalizedVector(DIM, 42), 0, 'cosine', -1)
      expect(results).toHaveLength(0)
    })

    it('empty store returns empty array', () => {
      const store = createVectorStore()
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(normalizedVector(DIM, 42), 5, 'cosine', -1)
      expect(results).toHaveLength(0)
    })

    it('dimension mismatch throws Error', () => {
      const store = createVectorStore()
      store.insert('doc1', normalizedVector(DIM, 1))
      const bf = createBruteForceSearch(DIM, store)

      expect(() => bf.search(new Float32Array(DIM + 1), 5, 'cosine', -1)).toThrow(/dimension mismatch/)
    })

    it('minSimilarity filters out low scores', () => {
      const store = createVectorStore()
      const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      store.insert('similar', vectorFromValues(0.95, 0.05, 0, 0, 0, 0, 0, 0))
      store.insert('orthogonal', vectorFromValues(0, 1, 0, 0, 0, 0, 0, 0))

      const bf = createBruteForceSearch(DIM, store)
      const results = bf.search(query, 10, 'cosine', 0.9)

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.9)
      }
      expect(results.some(r => r.docId === 'similar')).toBe(true)
      expect(results.every(r => r.docId !== 'orthogonal')).toBe(true)
    })

    it('filterDocIds restricts candidates to specified set', () => {
      const store = createVectorStore()
      populateStore(store, DIM, 20)
      const bf = createBruteForceSearch(DIM, store)

      const allowed = new Set(['doc0', 'doc1', 'doc2'])
      const results = bf.search(normalizedVector(DIM, 42), 10, 'cosine', -1, allowed)

      for (const r of results) {
        expect(allowed.has(r.docId)).toBe(true)
      }
      expect(results.length).toBeLessThanOrEqual(3)
    })

    it('filterDocIds with empty set returns empty', () => {
      const store = createVectorStore()
      populateStore(store, DIM, 10)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(normalizedVector(DIM, 42), 5, 'cosine', -1, new Set())
      expect(results).toHaveLength(0)
    })

    it('k larger than store returns all docs', () => {
      const store = createVectorStore()
      populateStore(store, DIM, 3)
      const bf = createBruteForceSearch(DIM, store)

      const results = bf.search(normalizedVector(DIM, 42), 100, 'cosine', -1)
      expect(results).toHaveLength(3)
    })

    it('exposes dimension property', () => {
      const store = createVectorStore()
      const bf = createBruteForceSearch(DIM, store)
      expect(bf.dimension).toBe(DIM)
    })
  })
})
