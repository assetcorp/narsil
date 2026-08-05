import { describe, expect, it, vi } from 'vitest'

vi.mock('../../vector/simd', async importOriginal => {
  const original = await importOriginal<typeof import('../../vector/simd')>()
  return { ...original, createArenaSimd: () => null }
})

import { createHNSWIndex } from '../../vector/hnsw'
import { createVectorStore } from '../../vector/vector-store'

function seededVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
  }
  return v
}

describe('VectorStore without an arena instance', () => {
  it('declines to prepare an arena query', () => {
    const store = createVectorStore()
    store.insert('doc0', seededVector(8, 1))
    expect(store.prepareQueryArena(seededVector(8, 2))).toBeNull()
  })

  it('still stores, reads back, and measures distance between vectors', () => {
    const dim = 12
    const store = createVectorStore()
    for (let i = 0; i < 40; i++) {
      store.insert(`doc${i}`, seededVector(dim, i + 1))
    }

    for (let ord = 0; ord < 40; ord++) {
      const entry = store.entryForOrdinal(ord)
      expect(entry).toBeDefined()
      if (!entry) continue
      expect(Array.from(entry.vector)).toEqual(Array.from(seededVector(dim, ord + 1)))
    }

    expect(store.distanceByOrdinal(0, 1, 'cosine')).toBeGreaterThan(0)
    expect(store.distanceByOrdinal(0, 0, 'euclidean')).toBeCloseTo(0, 6)
  })

  it('scores a graph search by plain cosine similarity', () => {
    const dim = 24
    const count = 60
    const store = createVectorStore()
    for (let i = 0; i < count; i++) {
      store.insert(`doc${i}`, seededVector(dim, i + 1))
    }
    expect(store.prepareQueryArena(seededVector(dim, 1))).toBeNull()

    const graph = createHNSWIndex(dim, store, { m: 8, efConstruction: 100, metric: 'cosine' })
    for (let i = 0; i < count; i++) {
      graph.insertNode(`doc${i}`)
    }

    const query = seededVector(dim, 500)
    const results = graph.search(query, 5, 'cosine', -1, undefined, 32)
    expect(results.length).toBe(5)

    for (const hit of results) {
      const ordinal = store.getOrdinal(hit.docId)
      expect(ordinal).toBeDefined()
      if (ordinal === undefined) continue
      const entry = store.entryForOrdinal(ordinal)
      expect(entry).toBeDefined()
      if (!entry) continue

      let dot = 0
      let queryNorm = 0
      let entryNorm = 0
      for (let i = 0; i < dim; i++) {
        dot += query[i] * entry.vector[i]
        queryNorm += query[i] * query[i]
        entryNorm += entry.vector[i] * entry.vector[i]
      }
      expect(hit.score).toBeCloseTo(dot / (Math.sqrt(queryNorm) * Math.sqrt(entryNorm)), 5)
    }
  })
})
