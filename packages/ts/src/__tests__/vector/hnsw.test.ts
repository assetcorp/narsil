import { beforeEach, describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../vector/hnsw'
import { createScalarQuantizer, type ScalarQuantizer } from '../../vector/scalar-quantization'
import { magnitude } from '../../vector/similarity'
import { createVectorStore, type VectorStore } from '../../vector/vector-store'

function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1
  }
  return v
}

function normalizedVector(dim: number): Float32Array {
  const v = randomVector(dim)
  const mag = magnitude(v)
  if (mag === 0) return v
  for (let i = 0; i < dim; i++) {
    v[i] /= mag
  }
  return v
}

function vectorFromValues(...values: number[]): Float32Array {
  return new Float32Array(values)
}

function insertVec(store: VectorStore, index: HNSWIndex, docId: string, vector: Float32Array): void {
  store.insert(docId, vector)
  index.insertNode(docId)
}

function removeVec(store: VectorStore, index: HNSWIndex, docId: string): void {
  index.markTombstone(docId)
  store.remove(docId)
}

describe('HNSWIndex', () => {
  const DIM = 8
  let store: VectorStore
  let index: HNSWIndex

  beforeEach(() => {
    store = createVectorStore()
    index = createHNSWIndex(DIM, store, { m: 4, efConstruction: 32, metric: 'cosine' })
  })

  describe('construction and basic operations', () => {
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

  describe('search (K-NN)', () => {
    it('returns empty for empty index', () => {
      const query = randomVector(DIM)
      const results = index.search(query, 5, 'cosine', 0)
      expect(results).toHaveLength(0)
    })

    it('rejects query with wrong dimension', () => {
      insertVec(store, index, 'doc1', randomVector(DIM))
      expect(() => index.search(new Float32Array(DIM + 1), 5, 'cosine', 0)).toThrow(/dimension mismatch/)
    })

    it('finds the nearest vector (cosine)', () => {
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const near = vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0)
      const far = vectorFromValues(0, 0, 0, 0, 0, 0, 0, 1)

      insertVec(store, index, 'near', near)
      insertVec(store, index, 'far', far)

      const results = index.search(target, 1, 'cosine', 0)
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('near')
    })

    it('returns at most k results', () => {
      for (let i = 0; i < 20; i++) {
        insertVec(store, index, `doc${i}`, randomVector(DIM))
      }

      const results = index.search(randomVector(DIM), 5, 'cosine', 0)
      expect(results.length).toBeLessThanOrEqual(5)
    })

    it('respects minSimilarity threshold', () => {
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const orthogonal = vectorFromValues(0, 1, 0, 0, 0, 0, 0, 0)
      const similar = vectorFromValues(0.95, 0.05, 0, 0, 0, 0, 0, 0)

      insertVec(store, index, 'orthogonal', orthogonal)
      insertVec(store, index, 'similar', similar)

      const results = index.search(target, 10, 'cosine', 0.9)
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.9)
      }
      expect(results.some(r => r.docId === 'similar')).toBe(true)
    })

    it('filters by docId set', () => {
      for (let i = 0; i < 20; i++) {
        insertVec(store, index, `doc${i}`, randomVector(DIM))
      }

      const allowed = new Set(['doc0', 'doc1', 'doc2'])
      const results = index.search(randomVector(DIM), 10, 'cosine', 0, allowed)

      for (const r of results) {
        expect(allowed.has(r.docId)).toBe(true)
      }
    })

    it('returns scores in descending order', () => {
      for (let i = 0; i < 30; i++) {
        insertVec(store, index, `doc${i}`, randomVector(DIM))
      }

      const results = index.search(randomVector(DIM), 10, 'cosine', 0)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    it('accepts efSearch parameter', () => {
      for (let i = 0; i < 30; i++) {
        insertVec(store, index, `doc${i}`, randomVector(DIM))
      }

      const resultsLowEf = index.search(randomVector(DIM), 5, 'cosine', 0, undefined, 5)
      const resultsHighEf = index.search(randomVector(DIM), 5, 'cosine', 0, undefined, 100)

      expect(resultsLowEf.length).toBeLessThanOrEqual(5)
      expect(resultsHighEf.length).toBeLessThanOrEqual(5)
    })
  })

  describe('search with different metrics', () => {
    it('searches with euclidean distance', () => {
      const eucStore = createVectorStore()
      const eucIndex = createHNSWIndex(DIM, eucStore, { m: 4, efConstruction: 32, metric: 'euclidean' })
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const near = vectorFromValues(1.1, 0.1, 0, 0, 0, 0, 0, 0)
      const far = vectorFromValues(5, 5, 5, 5, 5, 5, 5, 5)

      insertVec(eucStore, eucIndex, 'near', near)
      insertVec(eucStore, eucIndex, 'far', far)

      const results = eucIndex.search(target, 1, 'euclidean', 0)
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('near')
      expect(results[0].score).toBeGreaterThan(0)
    })

    it('searches with dot product', () => {
      const dpStore = createVectorStore()
      const dpIndex = createHNSWIndex(DIM, dpStore, { m: 4, efConstruction: 32, metric: 'dotProduct' })
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const highDp = vectorFromValues(10, 0, 0, 0, 0, 0, 0, 0)
      const lowDp = vectorFromValues(0, 10, 0, 0, 0, 0, 0, 0)

      insertVec(dpStore, dpIndex, 'highDp', highDp)
      insertVec(dpStore, dpIndex, 'lowDp', lowDp)

      const results = dpIndex.search(target, 1, 'dotProduct', -Infinity)
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('highDp')
    })
  })

  describe('recall quality', () => {
    it('achieves high recall on moderate dataset', () => {
      const recallStore = createVectorStore()
      const recallIndex = createHNSWIndex(32, recallStore, { m: 16, efConstruction: 100, metric: 'cosine' })
      const vectors = new Map<string, Float32Array>()
      const count = 500

      for (let i = 0; i < count; i++) {
        const v = normalizedVector(32)
        vectors.set(`doc${i}`, v)
        insertVec(recallStore, recallIndex, `doc${i}`, v)
      }

      const query = normalizedVector(32)
      const hnswResults = recallIndex.search(query, 10, 'cosine', 0, undefined, 64)
      const hnswDocIds = new Set(hnswResults.map(r => r.docId))

      const bruteForceResults: Array<{ docId: string; score: number }> = []
      for (const [docId, v] of vectors) {
        let score = 0
        const qMag = magnitude(query)
        const vMag = magnitude(v)
        if (qMag > 0 && vMag > 0) {
          let dp = 0
          for (let i = 0; i < query.length; i++) dp += query[i] * v[i]
          score = dp / (qMag * vMag)
        }
        bruteForceResults.push({ docId, score })
      }
      bruteForceResults.sort((a, b) => b.score - a.score)
      const trueTop10 = new Set(bruteForceResults.slice(0, 10).map(r => r.docId))

      let matches = 0
      for (const docId of trueTop10) {
        if (hnswDocIds.has(docId)) matches++
      }
      const recall = matches / trueTop10.size

      expect(recall).toBeGreaterThanOrEqual(0.7)
    })
  })

  describe('tombstone removal', () => {
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

  describe('compaction', () => {
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

  describe('serialize / deserialize', () => {
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
      delete (serialized as Record<string, unknown>).metric

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

  describe('graph structure integrity', () => {
    it('remaining nodes stay connected after heavy deletions', () => {
      const connStore = createVectorStore()
      const connIndex = createHNSWIndex(DIM, connStore, { m: 4, efConstruction: 32, metric: 'cosine' })
      for (let i = 0; i < 50; i++) {
        insertVec(connStore, connIndex, `doc${i}`, randomVector(DIM))
      }

      for (let i = 0; i < 25; i++) {
        removeVec(connStore, connIndex, `doc${i}`)
      }

      connIndex.rebuild()

      const serialized = connIndex.serialize()
      for (const [, , layerConns] of serialized.nodes) {
        const layer0 = layerConns.find(([l]) => l === 0)
        if (layer0) {
          expect(layer0[1].length).toBeGreaterThan(0)
        }
      }

      const results = connIndex.search(randomVector(DIM), 10, 'cosine', 0)
      expect(results.length).toBeGreaterThan(0)
    })

    it('most connections are bidirectional after insertion', () => {
      for (let i = 0; i < 20; i++) {
        insertVec(store, index, `doc${i}`, randomVector(DIM))
      }

      const serialized = index.serialize()
      const adjacency = new Map<string, Set<string>[]>()
      for (const [docId, maxLayer, layerConns] of serialized.nodes) {
        const layers: Set<string>[] = Array.from({ length: maxLayer + 1 }, () => new Set())
        for (const [layer, neighbors] of layerConns) {
          layers[layer] = new Set(neighbors)
        }
        adjacency.set(docId, layers)
      }

      let totalEdges = 0
      let bidirectionalEdges = 0
      for (const [docId, layers] of adjacency) {
        for (let layer = 0; layer < layers.length; layer++) {
          for (const neighborId of layers[layer]) {
            totalEdges++
            const neighborLayers = adjacency.get(neighborId)
            if (neighborLayers && layer < neighborLayers.length && neighborLayers[layer].has(docId)) {
              bidirectionalEdges++
            }
          }
        }
      }

      const bidirectionalRate = totalEdges > 0 ? bidirectionalEdges / totalEdges : 1
      expect(bidirectionalRate).toBeGreaterThanOrEqual(0.5)
    })

    it('node connections do not exceed Mmax0 at layer 0', () => {
      const largeStore = createVectorStore()
      const largeIndex = createHNSWIndex(DIM, largeStore, { m: 4, efConstruction: 32 })
      for (let i = 0; i < 50; i++) {
        insertVec(largeStore, largeIndex, `doc${i}`, randomVector(DIM))
      }

      const serialized = largeIndex.serialize()
      const Mmax0 = 4 * 2

      for (const [, , layerConns] of serialized.nodes) {
        for (const [layer, neighbors] of layerConns) {
          const maxConn = layer === 0 ? Mmax0 : 4
          expect(neighbors.length).toBeLessThanOrEqual(maxConn)
        }
      }
    })

    it('higher layers have fewer nodes', () => {
      const largeStore = createVectorStore()
      const largeIndex = createHNSWIndex(DIM, largeStore, { m: 8, efConstruction: 64 })
      for (let i = 0; i < 200; i++) {
        insertVec(largeStore, largeIndex, `doc${i}`, randomVector(DIM))
      }

      const serialized = largeIndex.serialize()
      const layerCounts = new Map<number, number>()

      for (const [, maxLayer] of serialized.nodes) {
        for (let layer = 0; layer <= maxLayer; layer++) {
          layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1)
        }
      }

      const sortedLayers = Array.from(layerCounts.entries()).sort((a, b) => a[0] - b[0])
      for (let i = 1; i < sortedLayers.length; i++) {
        expect(sortedLayers[i][1]).toBeLessThanOrEqual(sortedLayers[i - 1][1])
      }
    })
  })

  describe('edge cases', () => {
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

  describe('search with scalar quantization', () => {
    const SQ_DIM = 16
    let sqStore: VectorStore
    let sqQuantizer: ScalarQuantizer
    let sqIndex: HNSWIndex

    function sqInsert(docId: string, vector: Float32Array): void {
      sqStore.insert(docId, vector)
      sqIndex.insertNode(docId)
      sqQuantizer.quantize(docId, vector)
    }

    function sqNormalizedVector(seed: number): Float32Array {
      const v = new Float32Array(SQ_DIM)
      for (let i = 0; i < SQ_DIM; i++) {
        v[i] = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
      }
      const mag = magnitude(v)
      if (mag > 0) {
        for (let i = 0; i < SQ_DIM; i++) {
          v[i] /= mag
        }
      }
      return v
    }

    beforeEach(() => {
      sqStore = createVectorStore()
      sqQuantizer = createScalarQuantizer(SQ_DIM)
      sqIndex = createHNSWIndex(SQ_DIM, sqStore, { m: 8, efConstruction: 64, metric: 'cosine' }, sqQuantizer)
    })

    it('returns results when quantizer is calibrated', () => {
      const calibrationVecs: Float32Array[] = []
      for (let i = 0; i < 50; i++) {
        calibrationVecs.push(sqNormalizedVector(i + 1))
      }
      sqQuantizer.calibrate(calibrationVecs)

      for (let i = 0; i < 50; i++) {
        sqInsert(`doc${i}`, calibrationVecs[i])
      }

      const query = sqNormalizedVector(100)
      const results = sqIndex.search(query, 5, 'cosine', 0)
      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(5)
    })

    it('produces reasonable cosine scores between 0 and 1', () => {
      const calibrationVecs: Float32Array[] = []
      for (let i = 0; i < 30; i++) {
        calibrationVecs.push(sqNormalizedVector(i + 1))
      }
      sqQuantizer.calibrate(calibrationVecs)

      for (let i = 0; i < 30; i++) {
        sqInsert(`doc${i}`, calibrationVecs[i])
      }

      const query = sqNormalizedVector(50)
      const results = sqIndex.search(query, 10, 'cosine', 0)

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(-0.1)
        expect(r.score).toBeLessThanOrEqual(1.1)
      }
    })

    it('returns scores in descending order (reranking path)', () => {
      const calibrationVecs: Float32Array[] = []
      for (let i = 0; i < 40; i++) {
        calibrationVecs.push(sqNormalizedVector(i + 1))
      }
      sqQuantizer.calibrate(calibrationVecs)

      for (let i = 0; i < 40; i++) {
        sqInsert(`doc${i}`, calibrationVecs[i])
      }

      const query = sqNormalizedVector(200)
      const results = sqIndex.search(query, 10, 'cosine', 0)

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    it('ranks known close vector above known far vector', () => {
      const target = new Float32Array(SQ_DIM)
      target[0] = 1
      const near = new Float32Array(SQ_DIM)
      near[0] = 0.95
      near[1] = 0.05
      const far = new Float32Array(SQ_DIM)
      far[SQ_DIM - 1] = 1

      sqQuantizer.calibrate([target, near, far])
      sqInsert('near', near)
      sqInsert('far', far)

      const results = sqIndex.search(target, 2, 'cosine', 0)
      expect(results.length).toBe(2)
      expect(results[0].docId).toBe('near')
    })
  })

  describe('removeNodeEager graph repair', () => {
    it('remaining nodes are still reachable via search after middle removals', () => {
      const repairStore = createVectorStore()
      const repairIndex = createHNSWIndex(DIM, repairStore, { m: 4, efConstruction: 32, metric: 'cosine' })

      for (let i = 0; i < 30; i++) {
        insertVec(repairStore, repairIndex, `doc${i}`, randomVector(DIM))
      }

      for (let i = 10; i < 20; i++) {
        repairIndex.markTombstone(`doc${i}`)
        repairStore.remove(`doc${i}`)
      }

      repairIndex.compactTombstones()

      expect(repairIndex.size).toBe(20)
      expect(repairIndex.tombstoneCount).toBe(0)

      const query = randomVector(DIM)
      const results = repairIndex.search(query, 10, 'cosine', 0)
      expect(results.length).toBeGreaterThan(0)

      for (const r of results) {
        const docNum = Number.parseInt(r.docId.replace('doc', ''), 10)
        expect(docNum < 10 || docNum >= 20).toBe(true)
      }
    })

    it('survives entry point removal and selects a new entry point', () => {
      const epStore = createVectorStore()
      const epIndex = createHNSWIndex(DIM, epStore, { m: 4, efConstruction: 32, metric: 'cosine' })

      for (let i = 0; i < 20; i++) {
        insertVec(epStore, epIndex, `doc${i}`, randomVector(DIM))
      }

      const oldEntry = epIndex.entryPointId
      expect(oldEntry).not.toBeNull()

      if (oldEntry) {
        epIndex.markTombstone(oldEntry)
        epStore.remove(oldEntry)
        epIndex.compactTombstones()
      }

      expect(epIndex.entryPointId).not.toBeNull()
      expect(epIndex.entryPointId).not.toBe(oldEntry)

      const results = epIndex.search(randomVector(DIM), 5, 'cosine', 0)
      expect(results.length).toBeGreaterThan(0)
    })

    it('graph remains functional after multiple sequential compactions', () => {
      const multiStore = createVectorStore()
      const multiIndex = createHNSWIndex(DIM, multiStore, { m: 4, efConstruction: 32, metric: 'cosine' })

      for (let i = 0; i < 40; i++) {
        insertVec(multiStore, multiIndex, `doc${i}`, randomVector(DIM))
      }

      for (let i = 0; i < 10; i++) {
        multiIndex.markTombstone(`doc${i}`)
        multiStore.remove(`doc${i}`)
      }
      multiIndex.compactTombstones()

      for (let i = 10; i < 20; i++) {
        multiIndex.markTombstone(`doc${i}`)
        multiStore.remove(`doc${i}`)
      }
      multiIndex.compactTombstones()

      expect(multiIndex.size).toBe(20)
      expect(multiIndex.tombstoneCount).toBe(0)

      const results = multiIndex.search(randomVector(DIM), 10, 'cosine', 0)
      expect(results.length).toBeGreaterThan(0)

      for (const r of results) {
        const docNum = Number.parseInt(r.docId.replace('doc', ''), 10)
        expect(docNum).toBeGreaterThanOrEqual(20)
      }
    })
  })

  describe('neighbor selection heuristic (indirect verification)', () => {
    it('maintains recall quality even with tightly clustered vectors', () => {
      const clusterStore = createVectorStore()
      const clusterIndex = createHNSWIndex(DIM, clusterStore, { m: 8, efConstruction: 64, metric: 'cosine' })

      const allVecs = new Map<string, Float32Array>()

      for (let i = 0; i < 30; i++) {
        const v = new Float32Array(DIM)
        v[0] = 1
        for (let d = 1; d < DIM; d++) {
          v[d] = (Math.random() - 0.5) * 0.1
        }
        const mag = magnitude(v)
        for (let d = 0; d < DIM; d++) {
          v[d] /= mag
        }
        allVecs.set(`cluster${i}`, v)
        insertVec(clusterStore, clusterIndex, `cluster${i}`, v)
      }

      for (let i = 0; i < 10; i++) {
        const v = normalizedVector(DIM)
        allVecs.set(`outlier${i}`, v)
        insertVec(clusterStore, clusterIndex, `outlier${i}`, v)
      }

      const query = new Float32Array(DIM)
      query[0] = 1
      const qMag = magnitude(query)

      const hnswResults = clusterIndex.search(query, 5, 'cosine', 0, undefined, 64)

      const bruteForce: Array<{ docId: string; score: number }> = []
      for (const [docId, v] of allVecs) {
        const vMag = magnitude(v)
        if (qMag > 0 && vMag > 0) {
          let dp = 0
          for (let d = 0; d < DIM; d++) dp += query[d] * v[d]
          bruteForce.push({ docId, score: dp / (qMag * vMag) })
        }
      }
      bruteForce.sort((a, b) => b.score - a.score)

      const trueTop5 = new Set(bruteForce.slice(0, 5).map(r => r.docId))
      const hnswTop5 = new Set(hnswResults.map(r => r.docId))

      let matches = 0
      for (const docId of trueTop5) {
        if (hnswTop5.has(docId)) matches++
      }
      expect(matches).toBeGreaterThanOrEqual(3)
    })
  })
})
