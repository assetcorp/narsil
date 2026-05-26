import { beforeEach, describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../../vector/hnsw'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'
import { DIM, insertVec, randomVector, removeVec } from './fixtures'

describe('HNSWIndex graph structure integrity', () => {
  let store: VectorStore
  let index: HNSWIndex

  beforeEach(() => {
    store = createVectorStore()
    index = createHNSWIndex(DIM, store, { m: 4, efConstruction: 32, metric: 'cosine' })
  })

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
