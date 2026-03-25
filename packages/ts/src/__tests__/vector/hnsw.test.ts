import { beforeEach, describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../vector/hnsw'
import { magnitude } from '../../vector/similarity'

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

describe('HNSWIndex', () => {
  const DIM = 8
  let index: HNSWIndex

  beforeEach(() => {
    index = createHNSWIndex(DIM, { m: 4, efConstruction: 32, metric: 'cosine' })
  })

  describe('construction and basic operations', () => {
    it('starts empty with correct dimension', () => {
      expect(index.size).toBe(0)
      expect(index.dimension).toBe(DIM)
      expect(index.entryPointId).toBeNull()
      expect(index.topLayer).toBe(-1)
    })

    it('inserts a single vector and sets it as entry point', () => {
      const vec = randomVector(DIM)
      index.insert('doc1', vec)

      expect(index.size).toBe(1)
      expect(index.has('doc1')).toBe(true)
      expect(index.entryPointId).toBe('doc1')
      expect(index.topLayer).toBeGreaterThanOrEqual(0)
    })

    it('inserts multiple vectors', () => {
      for (let i = 0; i < 20; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }
      expect(index.size).toBe(20)
    })

    it('rejects vectors with wrong dimension', () => {
      expect(() => index.insert('doc1', new Float32Array(DIM + 1))).toThrow(/dimension mismatch/)
    })

    it('replaces existing vector on duplicate insert', () => {
      const v1 = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const v2 = vectorFromValues(0, 1, 0, 0, 0, 0, 0, 0)
      index.insert('doc1', v1)
      index.insert('doc1', v2)

      expect(index.size).toBe(1)
      expect(index.has('doc1')).toBe(true)
    })

    it('reports has correctly', () => {
      index.insert('doc1', randomVector(DIM))
      expect(index.has('doc1')).toBe(true)
      expect(index.has('nonexistent')).toBe(false)
    })

    it('clears all data', () => {
      for (let i = 0; i < 10; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }
      index.clear()

      expect(index.size).toBe(0)
      expect(index.entryPointId).toBeNull()
      expect(index.topLayer).toBe(-1)
    })

    it('iterates entries', () => {
      for (let i = 0; i < 5; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
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
      index.insert('doc1', randomVector(DIM))
      expect(() => index.search(new Float32Array(DIM + 1), 5, 'cosine', 0)).toThrow(/dimension mismatch/)
    })

    it('finds the nearest vector (cosine)', () => {
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const near = vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0)
      const far = vectorFromValues(0, 0, 0, 0, 0, 0, 0, 1)

      index.insert('near', near)
      index.insert('far', far)

      const results = index.search(target, 1, 'cosine', 0)
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('near')
    })

    it('returns at most k results', () => {
      for (let i = 0; i < 20; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      const results = index.search(randomVector(DIM), 5, 'cosine', 0)
      expect(results.length).toBeLessThanOrEqual(5)
    })

    it('respects minSimilarity threshold', () => {
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const orthogonal = vectorFromValues(0, 1, 0, 0, 0, 0, 0, 0)
      const similar = vectorFromValues(0.95, 0.05, 0, 0, 0, 0, 0, 0)

      index.insert('orthogonal', orthogonal)
      index.insert('similar', similar)

      const results = index.search(target, 10, 'cosine', 0.9)
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.9)
      }
      expect(results.some(r => r.docId === 'similar')).toBe(true)
    })

    it('filters by docId set', () => {
      for (let i = 0; i < 20; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      const allowed = new Set(['doc0', 'doc1', 'doc2'])
      const results = index.search(randomVector(DIM), 10, 'cosine', 0, allowed)

      for (const r of results) {
        expect(allowed.has(r.docId)).toBe(true)
      }
    })

    it('returns scores in descending order', () => {
      for (let i = 0; i < 30; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      const results = index.search(randomVector(DIM), 10, 'cosine', 0)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    it('accepts efSearch parameter', () => {
      for (let i = 0; i < 30; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      const resultsLowEf = index.search(randomVector(DIM), 5, 'cosine', 0, undefined, 5)
      const resultsHighEf = index.search(randomVector(DIM), 5, 'cosine', 0, undefined, 100)

      expect(resultsLowEf.length).toBeLessThanOrEqual(5)
      expect(resultsHighEf.length).toBeLessThanOrEqual(5)
    })
  })

  describe('search with different metrics', () => {
    it('searches with euclidean distance', () => {
      const eucIndex = createHNSWIndex(DIM, { m: 4, efConstruction: 32, metric: 'euclidean' })
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const near = vectorFromValues(1.1, 0.1, 0, 0, 0, 0, 0, 0)
      const far = vectorFromValues(5, 5, 5, 5, 5, 5, 5, 5)

      eucIndex.insert('near', near)
      eucIndex.insert('far', far)

      const results = eucIndex.search(target, 1, 'euclidean', 0)
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('near')
      expect(results[0].score).toBeGreaterThan(0)
    })

    it('searches with dot product', () => {
      const dpIndex = createHNSWIndex(DIM, { m: 4, efConstruction: 32, metric: 'dotProduct' })
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      const highDp = vectorFromValues(10, 0, 0, 0, 0, 0, 0, 0)
      const lowDp = vectorFromValues(0, 10, 0, 0, 0, 0, 0, 0)

      dpIndex.insert('highDp', highDp)
      dpIndex.insert('lowDp', lowDp)

      const results = dpIndex.search(target, 1, 'dotProduct', -Infinity)
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('highDp')
    })
  })

  describe('recall quality', () => {
    it('achieves high recall on moderate dataset', () => {
      const recallIndex = createHNSWIndex(32, { m: 16, efConstruction: 100, metric: 'cosine' })
      const vectors = new Map<string, Float32Array>()
      const count = 500

      for (let i = 0; i < count; i++) {
        const v = normalizedVector(32)
        vectors.set(`doc${i}`, v)
        recallIndex.insert(`doc${i}`, v)
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

  describe('removal', () => {
    it('removes a vector', () => {
      index.insert('doc1', randomVector(DIM))
      index.insert('doc2', randomVector(DIM))

      index.remove('doc1')
      expect(index.has('doc1')).toBe(false)
      expect(index.size).toBe(1)
    })

    it('removes nonexistent vector without error', () => {
      expect(() => index.remove('nonexistent')).not.toThrow()
    })

    it('removes the only vector', () => {
      index.insert('doc1', randomVector(DIM))
      index.remove('doc1')

      expect(index.size).toBe(0)
      expect(index.entryPointId).toBeNull()
      expect(index.topLayer).toBe(-1)
    })

    it('removes the entry point and elects a new one', () => {
      for (let i = 0; i < 10; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      const oldEntry = index.entryPointId
      expect(oldEntry).not.toBeNull()
      index.remove(oldEntry)

      expect(index.size).toBe(9)
      expect(index.entryPointId).not.toBeNull()
      expect(index.entryPointId).not.toBe(oldEntry)
    })

    it('removed vectors are excluded from search results', () => {
      const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
      index.insert('keep', vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0))
      index.insert('remove_me', vectorFromValues(0.95, 0.05, 0, 0, 0, 0, 0, 0))

      index.remove('remove_me')

      const results = index.search(target, 10, 'cosine', 0)
      expect(results.every(r => r.docId !== 'remove_me')).toBe(true)
    })

    it('search works after multiple removals', () => {
      for (let i = 0; i < 30; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      for (let i = 0; i < 15; i++) {
        index.remove(`doc${i}`)
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
        index.insert(`doc${i}`, randomVector(DIM))
      }
      for (let i = 0; i < 10; i++) {
        index.remove(`doc${i}`)
      }

      expect(index.size).toBe(0)
      expect(index.entryPointId).toBeNull()
      expect(index.topLayer).toBe(-1)
    })
  })

  describe('serialize / deserialize', () => {
    it('round-trips the graph structure', () => {
      for (let i = 0; i < 20; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      const serialized = index.serialize()

      expect(serialized.entryPoint).toBe(index.entryPointId)
      expect(serialized.maxLayer).toBe(index.topLayer)
      expect(serialized.m).toBe(index.m)
      expect(serialized.efConstruction).toBe(index.efConstruction)
      expect(serialized.nodes).toHaveLength(20)

      const vectorMap = new Map<string, { vector: Float32Array; mag: number }>()
      for (const [docId, entry] of index.entries()) {
        vectorMap.set(docId, { vector: entry.vector, mag: entry.magnitude })
      }

      const restored = createHNSWIndex(DIM, { m: 4, efConstruction: 32 })
      restored.deserialize(serialized, vectorMap)

      expect(restored.size).toBe(20)
      expect(restored.entryPointId).toBe(serialized.entryPoint)
      expect(restored.topLayer).toBe(serialized.maxLayer)
    })

    it('produces search results after deserialization', () => {
      for (let i = 0; i < 20; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      const serialized = index.serialize()
      const vectorMap = new Map<string, { vector: Float32Array; mag: number }>()
      for (const [docId, entry] of index.entries()) {
        vectorMap.set(docId, { vector: entry.vector, mag: entry.magnitude })
      }

      const restored = createHNSWIndex(DIM, { m: 4, efConstruction: 32 })
      restored.deserialize(serialized, vectorMap)

      const query = randomVector(DIM)
      const results = restored.search(query, 5, 'cosine', 0)
      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(5)
    })

    it('serialized node format matches the expected tuple structure', () => {
      index.insert('doc1', randomVector(DIM))
      index.insert('doc2', randomVector(DIM))

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
      const eucIndex = createHNSWIndex(DIM, { m: 4, efConstruction: 32, metric: 'euclidean' })
      eucIndex.insert('doc1', randomVector(DIM))

      const serialized = eucIndex.serialize()
      expect(serialized.metric).toBe('euclidean')
    })

    it('recovers when entry point vector is missing', () => {
      for (let i = 0; i < 10; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      const serialized = index.serialize()
      const vectorMap = new Map<string, { vector: Float32Array; mag: number }>()
      for (const [docId, entry] of index.entries()) {
        if (docId !== serialized.entryPoint) {
          vectorMap.set(docId, { vector: entry.vector, mag: entry.magnitude })
        }
      }

      const restored = createHNSWIndex(DIM, { m: 4, efConstruction: 32 })
      restored.deserialize(serialized, vectorMap)

      expect(restored.size).toBe(9)
      expect(restored.entryPointId).not.toBeNull()
      expect(restored.entryPointId).not.toBe(serialized.entryPoint)

      const results = restored.search(randomVector(DIM), 5, 'cosine', 0)
      expect(results.length).toBeGreaterThan(0)
    })

    it('handles all vectors missing during deserialization', () => {
      for (let i = 0; i < 5; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      const serialized = index.serialize()
      const emptyVectorMap = new Map<string, { vector: Float32Array; mag: number }>()

      const restored = createHNSWIndex(DIM, { m: 4, efConstruction: 32 })
      restored.deserialize(serialized, emptyVectorMap)

      expect(restored.size).toBe(0)
      expect(restored.entryPointId).toBeNull()
      expect(restored.topLayer).toBe(-1)

      const results = restored.search(randomVector(DIM), 5, 'cosine', 0)
      expect(results).toHaveLength(0)
    })

    it('deserializes data without metric field (backward compatibility)', () => {
      for (let i = 0; i < 10; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      const serialized = index.serialize()
      delete (serialized as Record<string, unknown>).metric

      const vectorMap = new Map<string, { vector: Float32Array; mag: number }>()
      for (const [docId, entry] of index.entries()) {
        vectorMap.set(docId, { vector: entry.vector, mag: entry.magnitude })
      }

      const restored = createHNSWIndex(DIM, { m: 4, efConstruction: 32, metric: 'euclidean' })
      restored.deserialize(serialized, vectorMap)

      expect(restored.size).toBe(10)
      expect(restored.entryPointId).not.toBeNull()
    })
  })

  describe('graph structure integrity', () => {
    it('remaining nodes stay connected after heavy deletions', () => {
      const connIndex = createHNSWIndex(DIM, { m: 4, efConstruction: 32, metric: 'cosine' })
      for (let i = 0; i < 50; i++) {
        connIndex.insert(`doc${i}`, randomVector(DIM))
      }

      for (let i = 0; i < 25; i++) {
        connIndex.remove(`doc${i}`)
      }

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
        index.insert(`doc${i}`, randomVector(DIM))
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
      const largeIndex = createHNSWIndex(DIM, { m: 4, efConstruction: 32 })
      for (let i = 0; i < 50; i++) {
        largeIndex.insert(`doc${i}`, randomVector(DIM))
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
      const largeIndex = createHNSWIndex(DIM, { m: 8, efConstruction: 64 })
      for (let i = 0; i < 200; i++) {
        largeIndex.insert(`doc${i}`, randomVector(DIM))
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
      index.insert('only', vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0))

      const results = index.search(vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0), 1, 'cosine', 0)
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('only')
      expect(results[0].score).toBeCloseTo(1, 5)
    })

    it('handles k larger than index size', () => {
      index.insert('doc1', randomVector(DIM))
      index.insert('doc2', randomVector(DIM))

      const results = index.search(randomVector(DIM), 100, 'cosine', 0)
      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('handles insert after clear', () => {
      index.insert('doc1', randomVector(DIM))
      index.clear()
      index.insert('doc2', randomVector(DIM))

      expect(index.size).toBe(1)
      expect(index.has('doc2')).toBe(true)
      expect(index.has('doc1')).toBe(false)
    })

    it('handles mixed insert and remove operations', () => {
      for (let i = 0; i < 10; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }
      index.remove('doc3')
      index.remove('doc7')
      index.insert('doc_new', randomVector(DIM))

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
      index.insert('zero', zeroVec)
      index.insert('nonzero', vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0))

      const results = index.search(vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0), 2, 'cosine', 0)
      expect(results.length).toBeGreaterThan(0)
    })

    it('filterDocIds with empty set returns no results', () => {
      for (let i = 0; i < 10; i++) {
        index.insert(`doc${i}`, randomVector(DIM))
      }

      const results = index.search(randomVector(DIM), 5, 'cosine', 0, new Set())
      expect(results).toHaveLength(0)
    })
  })
})
