import { beforeEach, describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../../vector/hnsw'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'
import { DIM, insertVec, randomVector } from './fixtures'

describe('HNSWIndex serialize / deserialize', () => {
  let store: VectorStore
  let index: HNSWIndex

  beforeEach(() => {
    store = createVectorStore()
    index = createHNSWIndex(DIM, store, { m: 4, efConstruction: 32, metric: 'cosine' })
  })

  it('round-trips the graph structure', () => {
    for (let i = 0; i < 20; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const serialized = index.serialize()

    expect(serialized.entryPoint).toBe(index.entryPointId)
    expect(serialized.maxLayer).toBe(index.topLayer)
    expect(serialized.m).toBe(index.m)
    expect(serialized.efConstruction).toBe(index.efConstruction)
    expect(serialized.nodes).toHaveLength(20)

    const restored = createHNSWIndex(DIM, store, { m: 4, efConstruction: 32 })
    restored.deserialize(serialized)

    expect(restored.size).toBe(20)
    expect(restored.entryPointId).toBe(serialized.entryPoint)
    expect(restored.topLayer).toBe(serialized.maxLayer)
  })

  it('produces search results after deserialization', () => {
    for (let i = 0; i < 20; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const serialized = index.serialize()

    const restored = createHNSWIndex(DIM, store, { m: 4, efConstruction: 32 })
    restored.deserialize(serialized)

    const query = randomVector(DIM)
    const results = restored.search(query, 5, 'cosine', 0)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('serialized node format matches the expected tuple structure', () => {
    insertVec(store, index, 'doc1', randomVector(DIM))
    insertVec(store, index, 'doc2', randomVector(DIM))

    const serialized = index.serialize()
    for (const node of serialized.nodes) {
      expect(node).toHaveLength(3)
      const [docId, maxLayer, layerConns] = node
      expect(typeof docId).toBe('string')
      expect(typeof maxLayer).toBe('number')
      expect(Array.isArray(layerConns)).toBe(true)
      for (const conn of layerConns) {
        expect(conn).toHaveLength(2)
        expect(typeof conn[0]).toBe('number')
        expect(Array.isArray(conn[1])).toBe(true)
      }
    }
  })

  it('serializes the build metric', () => {
    const eucStore = createVectorStore()
    const eucIndex = createHNSWIndex(DIM, eucStore, { m: 4, efConstruction: 32, metric: 'euclidean' })
    insertVec(eucStore, eucIndex, 'doc1', randomVector(DIM))

    const serialized = eucIndex.serialize()
    expect(serialized.metric).toBe('euclidean')
  })

  it('recovers when entry point vector is missing from store', () => {
    for (let i = 0; i < 10; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const serialized = index.serialize()
    const epDocId = serialized.entryPoint

    const partialStore = createVectorStore()
    for (const [docId, entry] of store.entries()) {
      if (docId !== epDocId) {
        partialStore.insert(docId, entry.vector)
      }
    }

    const restored = createHNSWIndex(DIM, partialStore, { m: 4, efConstruction: 32 })
    restored.deserialize(serialized)

    expect(restored.size).toBe(9)
    expect(restored.entryPointId).not.toBeNull()
    expect(restored.entryPointId).not.toBe(epDocId)

    const results = restored.search(randomVector(DIM), 5, 'cosine', 0)
    expect(results.length).toBeGreaterThan(0)
  })

  it('handles all vectors missing from store during deserialization', () => {
    for (let i = 0; i < 5; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const serialized = index.serialize()
    const emptyStore = createVectorStore()

    const restored = createHNSWIndex(DIM, emptyStore, { m: 4, efConstruction: 32 })
    restored.deserialize(serialized)

    expect(restored.size).toBe(0)
    expect(restored.entryPointId).toBeNull()
    expect(restored.topLayer).toBe(-1)

    const results = restored.search(randomVector(DIM), 5, 'cosine', 0)
    expect(results).toHaveLength(0)
  })

  it('deserializes data without metric field (backward compatibility)', () => {
    for (let i = 0; i < 10; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const serialized = index.serialize()
    delete (serialized as unknown as Record<string, unknown>).metric

    const restored = createHNSWIndex(DIM, store, { m: 4, efConstruction: 32, metric: 'euclidean' })
    restored.deserialize(serialized)

    expect(restored.size).toBe(10)
    expect(restored.entryPointId).not.toBeNull()
  })

  it('serialization excludes tombstoned nodes', () => {
    for (let i = 0; i < 10; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    index.markTombstone('doc0')
    index.markTombstone('doc1')

    const serialized = index.serialize()
    expect(serialized.nodes).toHaveLength(8)

    const serializedIds = new Set(serialized.nodes.map(([id]) => id))
    expect(serializedIds.has('doc0')).toBe(false)
    expect(serializedIds.has('doc1')).toBe(false)
  })
})
