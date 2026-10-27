import { noteLinked, noteUnlinked } from './incoming'
import { ABSENT, type Adjacency, nodeLevel, reachUpper } from './views'

export function layerArray(adj: Adjacency, layer: number): Int32Array {
  return layer === 0 ? adj.level0 : adj.upper
}

export function layerBase(adj: Adjacency, ord: number, layer: number): number {
  const level = nodeLevel(adj, ord)
  if (level === ABSENT || layer > level) return ABSENT
  if (layer === 0) return ord * adj.level0Stride
  const base = adj.upperBase[ord]
  if (base === 0) return ABSENT
  const start = base - 1 + (layer - 1) * adj.upperStride
  return reachUpper(adj, start + adj.upperStride) ? start : ABSENT
}

export function neighborCount(adj: Adjacency, ord: number, layer: number): number {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return 0
  return layerArray(adj, layer)[base]
}

export function readNeighbors(adj: Adjacency, ord: number, layer: number, out: Int32Array): number {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return 0
  const array = layerArray(adj, layer)
  const count = Math.min(array[base], out.length)
  for (let i = 0; i < count; i++) out[i] = array[base + i + 1]
  return count
}

export function collectNeighbors(adj: Adjacency, ord: number, layer: number): number[] {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return []
  const array = layerArray(adj, layer)
  const count = array[base]
  const collected: number[] = new Array(count)
  for (let i = 0; i < count; i++) collected[i] = array[base + i + 1]
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
  if (layer === 0) noteLinked(adj, neighborOrd)
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
    if (layer === 0) noteUnlinked(adj, neighborOrd)
    return
  }
}

export function writeNeighbors(
  adj: Adjacency,
  ord: number,
  layer: number,
  neighbors: ArrayLike<number>,
  count: number,
): void {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return

  const array = layerArray(adj, layer)
  const stride = layer === 0 ? adj.level0Stride : adj.upperStride
  const limit = Math.min(count, stride - 1)
  for (let i = 0; i < limit; i++) {
    array[base + i + 1] = neighbors[i]
  }
  array[base] = limit
}

function holds(neighbors: ArrayLike<number>, count: number, ord: number): boolean {
  for (let i = 0; i < count; i++) if (neighbors[i] === ord) return true
  return false
}

export function replaceNeighbors(
  adj: Adjacency,
  ord: number,
  layer: number,
  neighbors: ArrayLike<number>,
  count: number,
): void {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return
  if (layer > 0) {
    writeNeighbors(adj, ord, layer, neighbors, count)
    return
  }
  const array = adj.level0
  const held = array.slice(base + 1, base + 1 + array[base])
  const limit = Math.min(count, adj.level0Stride - 1)
  for (const former of held) if (!holds(neighbors, limit, former)) noteUnlinked(adj, former)
  for (let i = 0; i < limit; i++) if (!holds(held, held.length, neighbors[i])) noteLinked(adj, neighbors[i])
  writeNeighbors(adj, ord, 0, neighbors, count)
}
