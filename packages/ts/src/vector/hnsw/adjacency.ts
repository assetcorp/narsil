export const MAX_LAYER_CAP = 32

export const MAX_M = 512

const ABSENT = -1
const INITIAL_UPPER_SLOTS = 64

export interface Adjacency {
  readonly m: number
  readonly mMax0: number
  readonly level0Stride: number
  readonly upperStride: number
  capacity: number
  slots: number
  nodeLevels: Int8Array
  level0: Int32Array
  upperBase: Int32Array
  upper: Int32Array
  upperUsed: number
  freeBlocks: number[][]
}

export function createAdjacency(m: number, mMax0: number): Adjacency {
  return {
    m,
    mMax0,
    level0Stride: mMax0 + 2,
    upperStride: m + 2,
    capacity: 0,
    slots: 0,
    nodeLevels: new Int8Array(0),
    level0: new Int32Array(0),
    upperBase: new Int32Array(0),
    upper: new Int32Array(0),
    upperUsed: 0,
    freeBlocks: Array.from({ length: MAX_LAYER_CAP + 1 }, () => [] as number[]),
  }
}

export function ensureAdjacencyCapacity(adj: Adjacency, needed: number): void {
  if (needed <= adj.capacity) return

  let newCapacity = adj.capacity === 0 ? 16 : adj.capacity
  while (newCapacity < needed) newCapacity *= 2

  const nextLevels = new Int8Array(newCapacity).fill(ABSENT)
  nextLevels.set(adj.nodeLevels)
  adj.nodeLevels = nextLevels

  const nextLevel0 = new Int32Array(newCapacity * adj.level0Stride)
  nextLevel0.set(adj.level0)
  adj.level0 = nextLevel0

  const nextUpperBase = new Int32Array(newCapacity).fill(ABSENT)
  nextUpperBase.set(adj.upperBase)
  adj.upperBase = nextUpperBase

  adj.capacity = newCapacity
}

function allocateUpperBlock(adj: Adjacency, levels: number): number {
  const reusable = adj.freeBlocks[levels].pop()
  const size = levels * adj.upperStride

  if (reusable !== undefined) {
    adj.upper.fill(0, reusable, reusable + size)
    return reusable
  }

  if (adj.upperUsed + size > adj.upper.length) {
    const required = adj.upperUsed + size
    let nextLength = adj.upper.length === 0 ? INITIAL_UPPER_SLOTS * adj.upperStride : adj.upper.length
    while (nextLength < required) nextLength *= 2
    const nextUpper = new Int32Array(nextLength)
    nextUpper.set(adj.upper)
    adj.upper = nextUpper
  }

  const offset = adj.upperUsed
  adj.upperUsed += size
  adj.upper.fill(0, offset, offset + size)
  return offset
}

export function createNode(adj: Adjacency, ord: number, maxLayer: number): void {
  ensureAdjacencyCapacity(adj, ord + 1)
  if (ord >= adj.slots) adj.slots = ord + 1

  const existingLevel = adj.nodeLevels[ord]
  const existingBase = adj.upperBase[ord]
  if (existingLevel >= 1 && existingBase !== ABSENT) {
    adj.freeBlocks[existingLevel].push(existingBase)
  }

  adj.nodeLevels[ord] = maxLayer
  adj.level0[ord * adj.level0Stride] = 0
  adj.upperBase[ord] = maxLayer >= 1 ? allocateUpperBlock(adj, maxLayer) : ABSENT
}

export function deleteNode(adj: Adjacency, ord: number): void {
  if (ord < 0 || ord >= adj.capacity) return

  const level = adj.nodeLevels[ord]
  const base = adj.upperBase[ord]
  if (level >= 1 && base !== ABSENT) {
    adj.freeBlocks[level].push(base)
  }

  adj.nodeLevels[ord] = ABSENT
  adj.upperBase[ord] = ABSENT
  adj.level0[ord * adj.level0Stride] = 0
}

export function resetAdjacency(adj: Adjacency): void {
  adj.nodeLevels = new Int8Array(0)
  adj.level0 = new Int32Array(0)
  adj.upperBase = new Int32Array(0)
  adj.upper = new Int32Array(0)
  adj.upperUsed = 0
  adj.capacity = 0
  adj.slots = 0
  for (const list of adj.freeBlocks) list.length = 0
}

export function nodeLevel(adj: Adjacency, ord: number): number {
  if (ord < 0 || ord >= adj.capacity) return ABSENT
  return adj.nodeLevels[ord]
}

export function hasNode(adj: Adjacency, ord: number): boolean {
  return nodeLevel(adj, ord) !== ABSENT
}

export function layerArray(adj: Adjacency, layer: number): Int32Array {
  return layer === 0 ? adj.level0 : adj.upper
}

export function layerBase(adj: Adjacency, ord: number, layer: number): number {
  const level = nodeLevel(adj, ord)
  if (level === ABSENT || layer > level) return ABSENT
  if (layer === 0) return ord * adj.level0Stride
  const base = adj.upperBase[ord]
  if (base === ABSENT) return ABSENT
  return base + (layer - 1) * adj.upperStride
}

export function neighborCount(adj: Adjacency, ord: number, layer: number): number {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return 0
  return layerArray(adj, layer)[base]
}

export function collectNeighbors(adj: Adjacency, ord: number, layer: number): number[] {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return []

  const array = layerArray(adj, layer)
  const count = array[base]
  const collected: number[] = new Array(count)
  for (let i = 0; i < count; i++) {
    collected[i] = array[base + i + 1]
  }
  return collected
}

export function addNeighbor(adj: Adjacency, ord: number, layer: number, neighborOrd: number): void {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return

  const array = layerArray(adj, layer)
  const count = array[base]
  for (let i = 1; i <= count; i++) {
    if (array[base + i] === neighborOrd) return
  }

  const stride = layer === 0 ? adj.level0Stride : adj.upperStride
  if (count + 1 > stride - 1) return

  array[base + count + 1] = neighborOrd
  array[base] = count + 1
}

export function removeNeighbor(adj: Adjacency, ord: number, layer: number, neighborOrd: number): void {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return

  const array = layerArray(adj, layer)
  const count = array[base]
  for (let i = 1; i <= count; i++) {
    if (array[base + i] !== neighborOrd) continue
    for (let j = i; j < count; j++) {
      array[base + j] = array[base + j + 1]
    }
    array[base] = count - 1
    return
  }
}

export function replaceNeighbors(adj: Adjacency, ord: number, layer: number, neighbors: number[]): void {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return

  const array = layerArray(adj, layer)
  const stride = layer === 0 ? adj.level0Stride : adj.upperStride
  const limit = Math.min(neighbors.length, stride - 1)
  for (let i = 0; i < limit; i++) {
    array[base + i + 1] = neighbors[i]
  }
  array[base] = limit
}

/**
 * Every node's neighbours in the flat form the engine hands to another thread.
 *
 * @internal
 */
export interface AdjacencySnapshot {
  /** Each node keeps this many neighbours per layer above the base. */
  m: number
  /** Each node keeps this many neighbours on the base layer. */
  mMax0: number
  /** The arrays span this many ordinals. */
  capacity: number
  /** No node sits at an ordinal at or above this. */
  slots: number
  /** The upper-layer arena holds this many entries in use. */
  upperUsed: number
  /** Each ordinal's top layer, or -1 where no node sits there. */
  nodeLevels: Int8Array
  /** The base layer's neighbours, a count followed by neighbours per ordinal. */
  level0: Int32Array
  /** Where each ordinal's upper layers start, or -1 where it has none. */
  upperBase: Int32Array
  /** Every upper layer's neighbours, a count followed by neighbours per layer. */
  upper: Int32Array
}

export function exportAdjacency(adj: Adjacency): AdjacencySnapshot {
  return {
    m: adj.m,
    mMax0: adj.mMax0,
    capacity: adj.capacity,
    slots: adj.slots,
    upperUsed: adj.upperUsed,
    nodeLevels: adj.nodeLevels.slice(),
    level0: adj.level0.slice(),
    upperBase: adj.upperBase.slice(),
    upper: adj.upper.slice(0, adj.upperUsed),
  }
}

export function importAdjacency(snapshot: AdjacencySnapshot): Adjacency {
  const adj = createAdjacency(snapshot.m, snapshot.mMax0)
  adj.capacity = snapshot.capacity
  adj.slots = snapshot.slots
  adj.upperUsed = snapshot.upperUsed
  adj.nodeLevels = snapshot.nodeLevels
  adj.level0 = snapshot.level0
  adj.upperBase = snapshot.upperBase
  adj.upper = snapshot.upper
  return adj
}

export function estimateAdjacencyBytes(adj: Adjacency): number {
  return adj.nodeLevels.byteLength + adj.level0.byteLength + adj.upperBase.byteLength + adj.upper.byteLength
}
