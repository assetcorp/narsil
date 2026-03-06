import { beforeEach, describe, expect, it } from 'vitest'
import { createVectorSearchEngine, type VectorSearchEngine } from '../../search/vector-search'

function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1
  }
  return v
}

function vectorFromValues(...values: number[]): Float32Array {
  return new Float32Array(values)
}

describe('VectorSearchEngine', () => {
  const DIM = 8
  let engine: VectorSearchEngine

  beforeEach(() => {
    engine = createVectorSearchEngine(DIM)
  })

  describe('basic operations (brute-force mode)', () => {
    it('starts empty and unpromoted', () => {
      expect(engine.size).toBe(0)
      expect(engine.dimension).toBe(DIM)
      expect(engine.isPromoted).toBe(false)
    })

    it('inserts and retrieves vectors', () => {
      engine.insert('doc1', randomVector(DIM))
      expect(engine.size).toBe(1)
      expect(engine.has('doc1')).toBe(true)
    })

    it('removes vectors', () => {
      engine.insert('doc1', randomVector(DIM))
      engine.remove('doc1')
      expect(engine.has('doc1')).toBe(false)
      expect(engine.size).toBe(0)
    })

    it('searches with brute-force backend', () => {
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      engine.insert('near', vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0))
      engine.insert('far', vectorFromValues(0, 0, 0, 0, 0, 0, 0, 1))

      const results = engine.search(target, 1, 'cosine', 0)
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('near')
    })

    it('clears all data', () => {
      engine.insert('doc1', randomVector(DIM))
      engine.insert('doc2', randomVector(DIM))
      engine.clear()

      expect(engine.size).toBe(0)
      expect(engine.isPromoted).toBe(false)
    })

    it('iterates entries', () => {
      engine.insert('doc1', randomVector(DIM))
      engine.insert('doc2', randomVector(DIM))

      const entries = Array.from(engine.entries())
      expect(entries).toHaveLength(2)
      const docIds = entries.map(([id]) => id)
      expect(docIds).toContain('doc1')
      expect(docIds).toContain('doc2')
    })
  })

  describe('promotion to HNSW', () => {
    it('promotes to HNSW', () => {
      for (let i = 0; i < 20; i++) {
        engine.insert(`doc${i}`, randomVector(DIM))
      }

      expect(engine.isPromoted).toBe(false)
      engine.promoteToHNSW({ m: 4, efConstruction: 32 })
      expect(engine.isPromoted).toBe(true)
    })

    it('searches use HNSW after promotion', () => {
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      engine.insert('near', vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0))
      engine.insert('far', vectorFromValues(0, 0, 0, 0, 0, 0, 0, 1))

      engine.promoteToHNSW({ m: 4, efConstruction: 32 })

      const results = engine.search(target, 1, 'cosine', 0)
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('near')
    })

    it('inserts go to both stores after promotion', () => {
      engine.insert('existing', randomVector(DIM))
      engine.promoteToHNSW({ m: 4, efConstruction: 32 })

      engine.insert('new_doc', randomVector(DIM))
      expect(engine.size).toBe(2)
      expect(engine.has('new_doc')).toBe(true)

      const hnswIndex = engine.getHNSWIndex()
      expect(hnswIndex).not.toBeNull()
      expect(hnswIndex?.has('new_doc')).toBe(true)
    })

    it('removals propagate to both stores after promotion', () => {
      engine.insert('doc1', randomVector(DIM))
      engine.insert('doc2', randomVector(DIM))
      engine.promoteToHNSW({ m: 4, efConstruction: 32 })

      engine.remove('doc1')
      expect(engine.has('doc1')).toBe(false)

      const hnswIndex = engine.getHNSWIndex()
      expect(hnswIndex?.has('doc1')).toBe(false)
    })

    it('clear after promotion removes HNSW', () => {
      engine.insert('doc1', randomVector(DIM))
      engine.promoteToHNSW({ m: 4, efConstruction: 32 })
      engine.clear()

      expect(engine.isPromoted).toBe(false)
      expect(engine.getHNSWIndex()).toBeNull()
    })
  })

  describe('demotion', () => {
    it('demotes back to brute-force', () => {
      for (let i = 0; i < 10; i++) {
        engine.insert(`doc${i}`, randomVector(DIM))
      }
      engine.promoteToHNSW({ m: 4, efConstruction: 32 })
      expect(engine.isPromoted).toBe(true)

      engine.demoteToLinear()
      expect(engine.isPromoted).toBe(false)
      expect(engine.getHNSWIndex()).toBeNull()
      expect(engine.size).toBe(10)
    })

    it('search uses brute-force after demotion', () => {
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      engine.insert('near', vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0))
      engine.insert('far', vectorFromValues(0, 0, 0, 0, 0, 0, 0, 1))

      engine.promoteToHNSW({ m: 4, efConstruction: 32 })
      engine.demoteToLinear()

      const results = engine.search(target, 1, 'cosine', 0)
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('near')
    })
  })

  describe('HNSW serialization through engine', () => {
    it('returns null when not promoted', () => {
      engine.insert('doc1', randomVector(DIM))
      expect(engine.serializeHNSW()).toBeNull()
    })

    it('round-trips HNSW serialization', () => {
      for (let i = 0; i < 20; i++) {
        engine.insert(`doc${i}`, randomVector(DIM))
      }

      engine.promoteToHNSW({ m: 4, efConstruction: 32 })
      const serialized = engine.serializeHNSW()
      expect(serialized).not.toBeNull()

      const engine2 = createVectorSearchEngine(DIM)
      for (let i = 0; i < 20; i++) {
        engine2.insert(`doc${i}`, randomVector(DIM))
      }

      if (!serialized) throw new Error('Expected serialized HNSW')
      engine2.deserializeHNSW(serialized)
      expect(engine2.isPromoted).toBe(true)

      const results = engine2.search(randomVector(DIM), 5, 'cosine', 0)
      expect(results.length).toBeGreaterThan(0)
    })

    it('preserves build metric through serialization round-trip', () => {
      const eucEngine = createVectorSearchEngine(DIM, { metric: 'euclidean' })
      for (let i = 0; i < 10; i++) {
        eucEngine.insert(`doc${i}`, randomVector(DIM))
      }
      eucEngine.promoteToHNSW()

      const serialized = eucEngine.serializeHNSW()
      if (!serialized) throw new Error('Expected serialized HNSW')
      expect(serialized.metric).toBe('euclidean')

      const restored = createVectorSearchEngine(DIM)
      for (let i = 0; i < 10; i++) {
        restored.insert(`doc${i}`, randomVector(DIM))
      }
      restored.deserializeHNSW(serialized)

      const hnswIndex = restored.getHNSWIndex()
      expect(hnswIndex).not.toBeNull()
      expect(hnswIndex?.metric).toBe('euclidean')
    })
  })

  describe('efSearch parameter passthrough', () => {
    it('passes efSearch to HNSW backend', () => {
      for (let i = 0; i < 30; i++) {
        engine.insert(`doc${i}`, randomVector(DIM))
      }
      engine.promoteToHNSW({ m: 4, efConstruction: 32 })

      const results = engine.search(randomVector(DIM), 5, 'cosine', 0, undefined, 100)
      expect(results.length).toBeLessThanOrEqual(5)
    })

    it('ignores efSearch for brute-force backend', () => {
      for (let i = 0; i < 10; i++) {
        engine.insert(`doc${i}`, randomVector(DIM))
      }

      const results = engine.search(randomVector(DIM), 5, 'cosine', 0, undefined, 100)
      expect(results.length).toBeLessThanOrEqual(5)
    })
  })

  describe('accessor methods', () => {
    it('getBruteForceStore returns the underlying store', () => {
      engine.insert('doc1', randomVector(DIM))
      const store = engine.getBruteForceStore()
      expect(store.has('doc1')).toBe(true)
      expect(store.size).toBe(1)
    })

    it('getHNSWIndex returns null before promotion', () => {
      expect(engine.getHNSWIndex()).toBeNull()
    })

    it('getHNSWIndex returns the index after promotion', () => {
      engine.insert('doc1', randomVector(DIM))
      engine.promoteToHNSW({ m: 4, efConstruction: 32 })
      const hnswIndex = engine.getHNSWIndex()
      expect(hnswIndex).not.toBeNull()
      expect(hnswIndex?.size).toBe(1)
    })
  })
})
