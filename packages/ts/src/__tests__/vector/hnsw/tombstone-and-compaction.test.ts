import { beforeEach, describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../../vector/hnsw'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'
import { DIM, insertVec, randomVector, removeVec, vectorFromValues } from './fixtures'

describe('HNSWIndex tombstone removal', () => {
  let store: VectorStore
  let index: HNSWIndex

  beforeEach(() => {
    store = createVectorStore()
    index = createHNSWIndex(DIM, store, { m: 4, efConstruction: 32, metric: 'cosine' })
  })

  it('removes a vector via tombstone', () => {
    insertVec(store, index, 'doc1', randomVector(DIM))
    insertVec(store, index, 'doc2', randomVector(DIM))

    removeVec(store, index, 'doc1')
    expect(index.has('doc1')).toBe(false)
    expect(index.size).toBe(1)
  })

  it('tombstoning nonexistent vector does not throw', () => {
    expect(() => index.markTombstone('nonexistent')).not.toThrow()
  })

  it('removes the only vector', () => {
    insertVec(store, index, 'doc1', randomVector(DIM))
    removeVec(store, index, 'doc1')

    expect(index.size).toBe(0)
    expect(index.entryPointId).toBeNull()
  })

  it('removes the entry point and elects a new one', () => {
    for (let i = 0; i < 10; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    const oldEntry = index.entryPointId
    expect(oldEntry).not.toBeNull()
    removeVec(store, index, oldEntry as string)

    expect(index.size).toBe(9)
    expect(index.entryPointId).not.toBeNull()
    expect(index.entryPointId).not.toBe(oldEntry)
  })

  it('tombstoned vectors are excluded from search results', () => {
    const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
    insertVec(store, index, 'keep', vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0))
    insertVec(store, index, 'remove_me', vectorFromValues(0.95, 0.05, 0, 0, 0, 0, 0, 0))

    removeVec(store, index, 'remove_me')

    const results = index.search(target, 10, 'cosine', 0)
    expect(results.every(r => r.docId !== 'remove_me')).toBe(true)
  })

  it('search works after multiple removals', () => {
    for (let i = 0; i < 30; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    for (let i = 0; i < 15; i++) {
      removeVec(store, index, `doc${i}`)
    }

    expect(index.size).toBe(15)

    const results = index.search(randomVector(DIM), 5, 'cosine', 0)
    expect(results.length).toBeLessThanOrEqual(5)
    for (const r of results) {
      expect(Number.parseInt(r.docId.replace('doc', ''), 10)).toBeGreaterThanOrEqual(15)
    }
  })

  it('removes all vectors one by one', () => {
    for (let i = 0; i < 10; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }
    for (let i = 0; i < 10; i++) {
      removeVec(store, index, `doc${i}`)
    }

    expect(index.size).toBe(0)
    expect(index.entryPointId).toBeNull()
  })

  it('isTombstoned reports correctly', () => {
    insertVec(store, index, 'doc1', randomVector(DIM))
    expect(index.isTombstoned('doc1')).toBe(false)

    index.markTombstone('doc1')
    expect(index.isTombstoned('doc1')).toBe(true)
  })
})

describe('HNSWIndex compaction', () => {
  let store: VectorStore
  let index: HNSWIndex

  beforeEach(() => {
    store = createVectorStore()
    index = createHNSWIndex(DIM, store, { m: 4, efConstruction: 32, metric: 'cosine' })
  })

  it('compactionNeeded returns false when no tombstones', () => {
    for (let i = 0; i < 10; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }
    expect(index.compactionNeeded()).toBe(false)
  })

  it('compactionNeeded returns true when tombstone ratio exceeds threshold', () => {
    for (let i = 0; i < 10; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }
    index.markTombstone('doc0')
    store.remove('doc0')
    index.markTombstone('doc1')
    store.remove('doc1')

    expect(index.compactionNeeded()).toBe(true)
  })

  it('rebuild reconstructs the graph without tombstoned nodes', () => {
    for (let i = 0; i < 20; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    for (let i = 0; i < 5; i++) {
      index.markTombstone(`doc${i}`)
      store.remove(`doc${i}`)
    }

    expect(index.size).toBe(15)
    index.rebuild()
    expect(index.size).toBe(15)

    const results = index.search(randomVector(DIM), 5, 'cosine', 0)
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(Number.parseInt(r.docId.replace('doc', ''), 10)).toBeGreaterThanOrEqual(5)
    }
  })

  it('rebuild with all nodes tombstoned results in empty index', () => {
    for (let i = 0; i < 10; i++) {
      insertVec(store, index, `doc${i}`, randomVector(DIM))
    }

    for (let i = 0; i < 10; i++) {
      index.markTombstone(`doc${i}`)
      store.remove(`doc${i}`)
    }

    index.rebuild()
    expect(index.size).toBe(0)
    expect(index.entryPointId).toBeNull()
    expect(index.topLayer).toBe(-1)

    const results = index.search(randomVector(DIM), 5, 'cosine', 0)
    expect(results).toHaveLength(0)
  })
})
