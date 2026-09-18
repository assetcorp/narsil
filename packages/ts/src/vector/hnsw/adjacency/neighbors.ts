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

export function replaceNeighbors(
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
