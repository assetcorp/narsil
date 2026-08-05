import { describe, expect, it } from 'vitest'
import type { VectorMetric } from '../../vector/brute-force'
import { createHNSWIndex } from '../../vector/hnsw'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from '../../vector/similarity'
import { createVectorStore, type VectorStore } from '../../vector/vector-store'

const METRICS: VectorMetric[] = ['cosine', 'dotProduct', 'euclidean']

function seededVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
  }
  return v
}

function copyingDistance(query: Float32Array, entry: Float32Array, qMag: number, eMag: number, metric: VectorMetric) {
  switch (metric) {
    case 'cosine':
      return 1 - cosineSimilarityWithMagnitudes(query, entry, qMag, eMag)
    case 'dotProduct':
      return -dotProduct(query, entry)
    case 'euclidean':
      return euclideanDistance(query, entry)
  }
}

function populate(store: VectorStore, dim: number, count: number): void {
  for (let i = 0; i < count; i++) {
    store.insert(`doc${i}`, seededVector(dim, i + 1))
  }
}

describe('VectorStore arena query path', () => {
  for (const dim of [3, 16, 67, 384]) {
    it(`scores a ${dim}-dimension query exactly as the copying path does`, () => {
      const store = createVectorStore()
      populate(store, dim, 40)

      const query = seededVector(dim, 991)
      const qMag = magnitude(query)
      const prepared = store.prepareQueryArena(query)
      expect(prepared).not.toBeNull()
      if (!prepared) return
      expect(prepared.magnitude).toBe(qMag)

      for (const metric of METRICS) {
        for (let ord = 0; ord < 40; ord++) {
          const entry = store.entryForOrdinal(ord)
          expect(entry).toBeDefined()
          if (!entry) continue
          const expected = copyingDistance(query, entry.vector, qMag, entry.magnitude, metric)
          expect(store.distanceFromArena(prepared, ord, metric)).toBeCloseTo(expected, 6)
        }
      }
    })
  }

  it('keeps every stored vector intact across the capacity growth that follows the scratch region', () => {
    const dim = 384
    const count = 300
    const store = createVectorStore()
    populate(store, dim, count)

    for (let ord = 0; ord < count; ord++) {
      const entry = store.entryForOrdinal(ord)
      expect(entry).toBeDefined()
      if (!entry) continue
      expect(Array.from(entry.vector)).toEqual(Array.from(seededVector(dim, ord + 1)))
    }
  })

  it('measures node-to-node distance from the same offsets the query path uses', () => {
    const dim = 33
    const store = createVectorStore()
    populate(store, dim, 20)

    for (const metric of METRICS) {
      for (let ord = 1; ord < 20; ord++) {
        const a = store.entryForOrdinal(0)
        const b = store.entryForOrdinal(ord)
        expect(a).toBeDefined()
        expect(b).toBeDefined()
        if (!a || !b) continue
        const expected = copyingDistance(a.vector, b.vector, a.magnitude, b.magnitude, metric)
        expect(store.distanceByOrdinal(0, ord, metric)).toBeCloseTo(expected, 6)
      }
    }
  })

  it('refuses a query whose dimension differs from the stored vectors', () => {
    const store = createVectorStore()
    populate(store, 8, 4)
    expect(store.prepareQueryArena(new Float32Array(7))).toBeNull()
  })

  it('refuses a query before any vector is stored', () => {
    const store = createVectorStore()
    expect(store.prepareQueryArena(new Float32Array(8))).toBeNull()
  })

  it('reports an infinite distance for an ordinal that holds no live vector', () => {
    const store = createVectorStore()
    populate(store, 8, 4)
    store.remove('doc2')

    const prepared = store.prepareQueryArena(seededVector(8, 5))
    expect(prepared).not.toBeNull()
    if (!prepared) return

    expect(store.distanceFromArena(prepared, 2, 'cosine')).toBe(Number.POSITIVE_INFINITY)
    expect(store.distanceFromArena(prepared, 99, 'cosine')).toBe(Number.POSITIVE_INFINITY)
    expect(store.distanceFromArena(prepared, -1, 'cosine')).toBe(Number.POSITIVE_INFINITY)
  })

  it('reports a cosine distance of 1 when either side has no magnitude', () => {
    const store = createVectorStore()
    store.insert('zero', new Float32Array(8))
    store.insert('real', seededVector(8, 3))

    const zeroQuery = store.prepareQueryArena(new Float32Array(8))
    expect(zeroQuery).not.toBeNull()
    if (!zeroQuery) return
    expect(store.distanceFromArena(zeroQuery, 1, 'cosine')).toBe(1)

    const realQuery = store.prepareQueryArena(seededVector(8, 3))
    expect(realQuery).not.toBeNull()
    if (!realQuery) return
    expect(store.distanceFromArena(realQuery, 0, 'cosine')).toBe(1)
  })

  it('scores a query against a recycled ordinal after the document returns', () => {
    const store = createVectorStore()
    populate(store, 8, 4)
    store.remove('doc1')
    store.insert('doc1', seededVector(8, 77))

    const query = seededVector(8, 5)
    const prepared = store.prepareQueryArena(query)
    expect(prepared).not.toBeNull()
    if (!prepared) return

    const ordinal = store.getOrdinal('doc1')
    expect(ordinal).toBe(1)
    if (ordinal === undefined) return

    const entry = store.entryForOrdinal(ordinal)
    expect(entry).toBeDefined()
    if (!entry) return

    const expected = copyingDistance(query, entry.vector, magnitude(query), entry.magnitude, 'cosine')
    expect(store.distanceFromArena(prepared, ordinal, 'cosine')).toBeCloseTo(expected, 6)
  })

  it('scores a graph search by plain cosine similarity', () => {
    const dim = 24
    const count = 60
    const store = createVectorStore()
    populate(store, dim, count)

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

  it('serves a query at a new dimension after the store is cleared', () => {
    const store = createVectorStore()
    populate(store, 8, 4)
    store.clear()
    populate(store, 96, 10)

    const query = seededVector(96, 42)
    const prepared = store.prepareQueryArena(query)
    expect(prepared).not.toBeNull()
    if (!prepared) return

    const entry = store.entryForOrdinal(3)
    expect(entry).toBeDefined()
    if (!entry) return

    const expected = copyingDistance(query, entry.vector, magnitude(query), entry.magnitude, 'cosine')
    expect(store.distanceFromArena(prepared, 3, 'cosine')).toBeCloseTo(expected, 6)
  })
})
