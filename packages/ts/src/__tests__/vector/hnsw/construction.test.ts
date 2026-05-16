import { beforeEach, describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../../vector/hnsw'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'
import { DIM, insertVec, randomVector, vectorFromValues } from './fixtures'

describe('HNSWIndex construction and basic operations', () => {
  let store: VectorStore
  let index: HNSWIndex

  beforeEach(() => {
    store = createVectorStore()
    index = createHNSWIndex(DIM, store, { m: 4, efConstruction: 32, metric: 'cosine' })
  })

  it('starts empty with correct dimension', () => {
    expect(index.size).toBe(0)
    expect(index.dimension).toBe(DIM)
    expect(index.entryPointId).toBeNull()
    expect(index.topLayer).toBe(-1)
  })

  it('inserts a single vector and sets it as entry point', () => {
    insertVec(store, index, 'doc1', randomVector(DIM))

    expect(index.size).toBe(1)
    expect(index.has('doc1')).toBe(true)
    expect(index.entryPointId).toBe('doc1')
    expect(index.topLayer).toBeGreaterThanOrEqual(0)
  })

  it('inserts multiple vectors', () => {
    for (let i = 0; i < 20; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }
    expect(index.size).toBe(20)
  })

  it('rejects insert when vector is not in store', () => {
    expect(() => index.insertNode('missing')).toThrow(/not found in VectorStore/)
  })

  it('replaces existing vector on duplicate insert', () => {
    const v1 = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
    const v2 = vectorFromValues(0, 1, 0, 0, 0, 0, 0, 0)
    insertVec(store, index, 'doc1', v1)
    store.remove('doc1')
    insertVec(store, index, 'doc1', v2)

    expect(index.size).toBe(1)
    expect(index.has('doc1')).toBe(true)
  })

  it('reports has correctly', () => {
    insertVec(store, index, 'doc1', randomVector(DIM))
    expect(index.has('doc1')).toBe(true)
    expect(index.has('nonexistent')).toBe(false)
  })

  it('clears all data', () => {
    for (let i = 0; i < 10; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }
    index.clear()

    expect(index.size).toBe(0)
    expect(index.entryPointId).toBeNull()
    expect(index.topLayer).toBe(-1)
  })

  it('iterates entries', () => {
    for (let i = 0; i < 5; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const entries = Array.from(index.entries())
    expect(entries).toHaveLength(5)

    for (const [docId, entry] of entries) {
      expect(docId).toBe(entry.docId)
      expect(entry.vector).toBeInstanceOf(Float32Array)
      expect(entry.vector.length).toBe(DIM)
      expect(entry.magnitude).toBeGreaterThan(0)
    }
  })

  it('exposes configuration parameters', () => {
    expect(index.m).toBe(4)
    expect(index.efConstruction).toBe(32)
    expect(index.metric).toBe('cosine')
  })
})
