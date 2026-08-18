import { describe, expect, it } from 'vitest'
import {
  addNeighbor,
  collectNeighbors,
  createAdjacency,
  createNode,
  deleteNode,
  hasNode,
  layerBase,
  MAX_LAYER_CAP,
  neighborCount,
  nodeLevel,
  removeNeighbor,
  replaceNeighbors,
  resetAdjacency,
} from '../../../vector/hnsw/adjacency'

const M = 8
const MMAX0 = 16

function newAdjacency() {
  return createAdjacency(M, MMAX0)
}

describe('flat adjacency', () => {
  it('reports a node absent until it is created and again once it is deleted', () => {
    const adj = newAdjacency()
    expect(hasNode(adj, 5)).toBe(false)
    expect(nodeLevel(adj, 5)).toBe(-1)

    createNode(adj, 5, 2)
    expect(hasNode(adj, 5)).toBe(true)
    expect(nodeLevel(adj, 5)).toBe(2)

    deleteNode(adj, 5)
    expect(hasNode(adj, 5)).toBe(false)
    expect(nodeLevel(adj, 5)).toBe(-1)
  })

  it('reports no layer beyond the level a node was created at', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 1)
    expect(layerBase(adj, 0, 0)).not.toBe(-1)
    expect(layerBase(adj, 0, 1)).not.toBe(-1)
    expect(layerBase(adj, 0, 2)).toBe(-1)
    expect(layerBase(adj, 99, 0)).toBe(-1)
  })

  it('keeps neighbours in the order they were added', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 1)
    for (const ord of [7, 3, 9, 1]) {
      addNeighbor(adj, 0, 0, ord)
      addNeighbor(adj, 0, 1, ord)
    }
    expect(collectNeighbors(adj, 0, 0)).toEqual([7, 3, 9, 1])
    expect(collectNeighbors(adj, 0, 1)).toEqual([7, 3, 9, 1])
  })

  it('ignores a neighbour that is already recorded', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 0)
    addNeighbor(adj, 0, 0, 4)
    addNeighbor(adj, 0, 0, 4)
    expect(collectNeighbors(adj, 0, 0)).toEqual([4])
    expect(neighborCount(adj, 0, 0)).toBe(1)
  })

  it('closes the gap when a neighbour is removed', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 0)
    for (const ord of [1, 2, 3, 4]) addNeighbor(adj, 0, 0, ord)
    removeNeighbor(adj, 0, 0, 2)
    expect(collectNeighbors(adj, 0, 0)).toEqual([1, 3, 4])
    removeNeighbor(adj, 0, 0, 99)
    expect(collectNeighbors(adj, 0, 0)).toEqual([1, 3, 4])
  })

  it('holds one neighbour above the layer maximum so a prune can run afterwards', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 1)
    for (let i = 1; i <= MMAX0 + 5; i++) addNeighbor(adj, 0, 0, i)
    expect(neighborCount(adj, 0, 0)).toBe(MMAX0 + 1)

    for (let i = 1; i <= M + 5; i++) addNeighbor(adj, 0, 1, i)
    expect(neighborCount(adj, 0, 1)).toBe(M + 1)
  })

  it('replaces a whole layer without leaving earlier neighbours behind', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 0)
    for (const ord of [1, 2, 3, 4, 5]) addNeighbor(adj, 0, 0, ord)
    replaceNeighbors(adj, 0, 0, [9, 8])
    expect(collectNeighbors(adj, 0, 0)).toEqual([9, 8])
  })

  it('keeps every node intact when capacity grows', () => {
    const adj = newAdjacency()
    for (let ord = 0; ord < 500; ord++) {
      createNode(adj, ord, ord % 3)
      addNeighbor(adj, ord, 0, ord + 1000)
      if (ord % 3 >= 1) addNeighbor(adj, ord, 1, ord + 2000)
    }

    for (let ord = 0; ord < 500; ord++) {
      expect(nodeLevel(adj, ord)).toBe(ord % 3)
      expect(collectNeighbors(adj, ord, 0)).toEqual([ord + 1000])
      if (ord % 3 >= 1) {
        expect(collectNeighbors(adj, ord, 1)).toEqual([ord + 2000])
      }
    }
  })

  it('reuses an upper block once its node is deleted', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 4)
    const usedAfterFirst = adj.upperUsed

    for (let round = 0; round < 50; round++) {
      deleteNode(adj, 0)
      createNode(adj, 0, 4)
    }

    expect(adj.upperUsed).toBe(usedAfterFirst)
  })

  it('hands back a reused block with no neighbours left in it', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 2)
    addNeighbor(adj, 0, 1, 42)
    addNeighbor(adj, 0, 2, 43)
    deleteNode(adj, 0)

    createNode(adj, 1, 2)
    expect(collectNeighbors(adj, 1, 1)).toEqual([])
    expect(collectNeighbors(adj, 1, 2)).toEqual([])
  })

  it('frees the previous block when a node is created over a live one', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 3)
    const usedAfterFirst = adj.upperUsed
    createNode(adj, 0, 3)
    createNode(adj, 0, 3)
    expect(adj.upperUsed).toBe(usedAfterFirst)
    expect(collectNeighbors(adj, 0, 1)).toEqual([])
  })

  it('separates the blocks of two nodes at the same level', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 2)
    createNode(adj, 1, 2)
    addNeighbor(adj, 0, 1, 100)
    addNeighbor(adj, 1, 1, 200)
    expect(collectNeighbors(adj, 0, 1)).toEqual([100])
    expect(collectNeighbors(adj, 1, 1)).toEqual([200])
  })

  it('writes no neighbour into the slot of the node that follows it', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 0)
    createNode(adj, 1, 0)
    for (let i = 1; i <= MMAX0 + 5; i++) addNeighbor(adj, 0, 0, i)
    expect(collectNeighbors(adj, 1, 0)).toEqual([])
  })

  it('empties every node when the adjacency is reset', () => {
    const adj = newAdjacency()
    createNode(adj, 0, 3)
    addNeighbor(adj, 0, 0, 1)
    resetAdjacency(adj)

    expect(adj.slots).toBe(0)
    expect(adj.upperUsed).toBe(0)
    expect(hasNode(adj, 0)).toBe(false)
  })

  it('allocates a block for every level up to the cap', () => {
    const adj = newAdjacency()
    createNode(adj, 0, MAX_LAYER_CAP)
    for (let layer = 0; layer <= MAX_LAYER_CAP; layer++) {
      addNeighbor(adj, 0, layer, layer + 1)
      expect(collectNeighbors(adj, 0, layer)).toEqual([layer + 1])
    }
  })
})
