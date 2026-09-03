import { describe, expect, it } from 'vitest'
import { createHNSWIndex } from '../../../vector/hnsw'
import { createVectorStore } from '../../../vector/vector-store'
import { DIM, insertVec, seededVector } from './fixtures'

function unitVector(...values: number[]): Float32Array {
  const vector = new Float32Array(DIM)
  vector.set(values.slice(0, DIM))
  let sumSquares = 0
  for (let i = 0; i < DIM; i++) sumSquares += vector[i] * vector[i]
  const length = Math.sqrt(sumSquares)
  if (length === 0) return vector
  for (let i = 0; i < DIM; i++) vector[i] /= length
  return vector
}

function baseLayerNeighbours(nodes: Array<[string, number, Array<[number, string[]]>]>, docId: string): string[] {
  for (const [id, , layers] of nodes) {
    if (id !== docId) continue
    for (const [layer, connections] of layers) {
      if (layer === 0) return connections
    }
    return []
  }
  throw new Error(`the serialised graph holds no node for ${docId}`)
}

describe('HNSW neighbour selection', () => {
  it('links a new vector to the diverse candidates alone', () => {
    const store = createVectorStore()
    const index = createHNSWIndex(DIM, store, { m: 8, efConstruction: 32, metric: 'cosine' })

    insertVec(store, index, 'anchor', unitVector(1, 0, 0, 0, 0, 0, 0, 0))
    insertVec(store, index, 'neighbour-of-anchor', unitVector(Math.cos(0.1), Math.sin(0.1), 0, 0, 0, 0, 0, 0))
    insertVec(store, index, 'distant', unitVector(0.02, 0, 1, 0, 0, 0, 0, 0))

    const nodes = index.serialize().nodes
    expect(baseLayerNeighbours(nodes, 'distant')).toEqual(['anchor'])
  })

  it('caps a vector at twice m links on the base layer', () => {
    const store = createVectorStore()
    const m = 2
    const index = createHNSWIndex(DIM, store, { m, efConstruction: 32, metric: 'cosine' })

    insertVec(store, index, 'centre', unitVector(1, 1, 1, 1, 1, 1, 1, 1))
    for (let axis = 0; axis < DIM; axis++) {
      const corner = new Float32Array(DIM)
      corner[axis] = 1
      insertVec(store, index, `axis${axis}`, corner)
    }

    const nodes = index.serialize().nodes
    expect(baseLayerNeighbours(nodes, 'centre')).toHaveLength(2 * m)
  })

  it('leaves the base layer lists below the cap across a larger graph', () => {
    const store = createVectorStore()
    const m = 4
    const index = createHNSWIndex(DIM, store, { m, efConstruction: 32, metric: 'cosine' })

    const count = 240
    for (let i = 0; i < count; i++) {
      insertVec(store, index, `doc${i}`, seededVector(DIM, i + 1))
    }

    const nodes = index.serialize().nodes
    let totalLinks = 0
    for (const [docId] of nodes) {
      const links = baseLayerNeighbours(nodes, docId)
      expect(links.length).toBeLessThanOrEqual(2 * m)
      totalLinks += links.length
    }

    expect(totalLinks / nodes.length).toBeLessThan(2 * m)
  })
})
