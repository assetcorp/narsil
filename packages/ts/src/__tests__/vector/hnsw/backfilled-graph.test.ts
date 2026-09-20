import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createHNSWIndex, type SerializedHNSWGraph } from '../../../vector/hnsw'
import { createVectorStore } from '../../../vector/vector-store'
import { createExactSearch } from '../exact-search'
import { DIM, seededVector } from './fixtures'

const BACKFILLED_VECTOR_COUNT = 240

function loadBackfilledGraph(): SerializedHNSWGraph {
  const raw = readFileSync(new URL('./fixtures/backfilled-graph.json', import.meta.url), 'utf-8')
  return JSON.parse(raw) as SerializedHNSWGraph
}

describe('a graph whose neighbour lists were backfilled to the cap', () => {
  it('loads and answers searches', () => {
    const graph = loadBackfilledGraph()
    const store = createVectorStore()
    for (let i = 0; i < BACKFILLED_VECTOR_COUNT; i++) {
      store.insert(`doc${i}`, seededVector(DIM, i + 1))
    }

    const index = createHNSWIndex(DIM, store, { m: graph.m, efConstruction: graph.efConstruction, metric: 'cosine' })
    index.deserialize(graph)

    expect(index.size).toBe(BACKFILLED_VECTOR_COUNT)

    const bruteForce = createExactSearch(DIM, store)
    let hits = 0
    const queryCount = 20
    for (let q = 0; q < queryCount; q++) {
      const query = seededVector(DIM, q * 7 + 3)
      const exact = new Set(bruteForce.search(query, 10, 'cosine', -1).map(result => result.docId))
      const approximate = index.search(query, 10, 'cosine', -1, { efSearch: 64 })
      expect(approximate).toHaveLength(10)
      for (const result of approximate) {
        if (exact.has(result.docId)) hits++
      }
    }

    expect(hits / (queryCount * 10)).toBeGreaterThanOrEqual(0.9)
  })
})
