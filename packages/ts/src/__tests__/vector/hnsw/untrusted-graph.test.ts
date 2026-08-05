import { describe, expect, it } from 'vitest'
import { createHNSWIndex, type SerializedHNSWGraph } from '../../../vector/hnsw'
import { createVectorStore } from '../../../vector/vector-store'

const DIM = 8
const COUNT = 40
const M = 8

function seededVector(seed: number): Float32Array {
  const v = new Float32Array(DIM)
  for (let i = 0; i < DIM; i++) {
    v[i] = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
  }
  return v
}

function populatedStore() {
  const store = createVectorStore()
  for (let i = 0; i < COUNT; i++) {
    store.insert(`doc${i}`, seededVector(i + 1))
  }
  return store
}

function allDocIds(): string[] {
  return Array.from({ length: COUNT }, (_, i) => `doc${i}`)
}

describe('a graph payload that does not match this configuration', () => {
  it('caps a node claiming far more layers than the implementation builds', () => {
    const store = populatedStore()
    const graph = createHNSWIndex(DIM, store, { m: M, efConstruction: 50, metric: 'cosine' })

    const payload: SerializedHNSWGraph = {
      entryPoint: 'doc0',
      maxLayer: 5000,
      m: M,
      efConstruction: 50,
      metric: 'cosine',
      nodes: [
        ['doc0', 5000, [[0, ['doc1', 'doc2']]]],
        ['doc1', 0, [[0, ['doc0']]]],
        ['doc2', 0, [[0, ['doc0']]]],
      ],
    }

    expect(() => graph.deserialize(payload)).not.toThrow()
    expect(graph.size).toBe(3)
    expect(graph.search(seededVector(1), 3, 'cosine', -1).length).toBeGreaterThan(0)
  })

  it('caps a layer holding more neighbours than the layer maximum allows', () => {
    const store = populatedStore()
    const graph = createHNSWIndex(DIM, store, { m: M, efConstruction: 50, metric: 'cosine' })

    const everyDoc = allDocIds()
    const flooded = [...everyDoc, ...everyDoc, ...everyDoc]

    const payload: SerializedHNSWGraph = {
      entryPoint: 'doc0',
      maxLayer: 0,
      m: M,
      efConstruction: 50,
      metric: 'cosine',
      nodes: everyDoc.map(docId => [docId, 0, [[0, flooded]]] as [string, number, Array<[number, string[]]>]),
    }

    graph.deserialize(payload)

    expect(graph.size).toBe(COUNT)
    const results = graph.search(seededVector(3), 5, 'cosine', -1)
    expect(results.length).toBe(5)
    for (const hit of results) {
      expect(store.getOrdinal(hit.docId)).toBeDefined()
    }
  })

  it('ignores a neighbour list naming documents the store never held', () => {
    const store = populatedStore()
    const graph = createHNSWIndex(DIM, store, { m: M, efConstruction: 50, metric: 'cosine' })

    const payload: SerializedHNSWGraph = {
      entryPoint: 'doc0',
      maxLayer: 0,
      m: M,
      efConstruction: 50,
      metric: 'cosine',
      nodes: [
        ['doc0', 0, [[0, ['ghost1', 'doc1', 'ghost2']]]],
        ['doc1', 0, [[0, ['doc0']]]],
        ['missing', 0, [[0, ['doc0']]]],
      ],
    }

    graph.deserialize(payload)

    expect(graph.size).toBe(2)
    expect(graph.has('doc0')).toBe(true)
    expect(graph.has('doc1')).toBe(true)
    expect(graph.has('missing')).toBe(false)
  })

  it('drops a layer index that sits above the node it belongs to', () => {
    const store = populatedStore()
    const graph = createHNSWIndex(DIM, store, { m: M, efConstruction: 50, metric: 'cosine' })

    const payload: SerializedHNSWGraph = {
      entryPoint: 'doc0',
      maxLayer: 0,
      m: M,
      efConstruction: 50,
      metric: 'cosine',
      nodes: [
        ['doc0', 0, [[9, ['doc1']]]],
        ['doc1', 0, [[0, ['doc0']]]],
      ],
    }

    expect(() => graph.deserialize(payload)).not.toThrow()
    expect(graph.size).toBe(2)
  })

  it('rebuilds a graph read back from its own serialised form', () => {
    const store = populatedStore()
    const graph = createHNSWIndex(DIM, store, { m: M, efConstruction: 50, metric: 'cosine' })
    for (const docId of allDocIds()) graph.insertNode(docId)

    const query = seededVector(500)
    const before = graph.search(query, 5, 'cosine', -1, undefined, 32)

    const restored = createHNSWIndex(DIM, store, { m: M, efConstruction: 50, metric: 'cosine' })
    restored.deserialize(graph.serialize())

    const after = restored.search(query, 5, 'cosine', -1, undefined, 32)
    expect(after.map(h => h.docId)).toEqual(before.map(h => h.docId))
    expect(after.map(h => h.score)).toEqual(before.map(h => h.score))
  })
})
