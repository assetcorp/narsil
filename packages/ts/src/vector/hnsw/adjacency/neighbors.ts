import { ABSENT, type Adjacency, nodeLevel, reachUpper } from './views'

/**
 * Reports the array that holds one layer's neighbour lists.
 *
 * @param adj The thread's views over the graph.
 * @param layer The layer to read.
 * @returns The base layer's array for layer zero, and the upper arena above it.
 *
 * @internal
 */
export function layerArray(adj: Adjacency, layer: number): Int32Array {
  return layer === 0 ? adj.level0 : adj.upper
}

/**
 * Reports where a node's neighbour list starts on one layer.
 *
 * @param adj The thread's views over the graph.
 * @param ord The node to read.
 * @param layer The layer to read.
 * @returns The index of the list's count, or -1 where the node reaches no
 * such layer.
 *
 * @internal
 */
export function layerBase(adj: Adjacency, ord: number, layer: number): number {
  const level = nodeLevel(adj, ord)
  if (level === ABSENT || layer > level) return ABSENT
  if (layer === 0) return ord * adj.level0Stride
  const base = adj.upperBase[ord]
  if (base === 0) return ABSENT
  const start = base - 1 + (layer - 1) * adj.upperStride
  return reachUpper(adj, start + adj.upperStride) ? start : ABSENT
}

/**
 * Reports how many neighbours a node keeps on one layer.
 *
 * @param adj The thread's views over the graph.
 * @param ord The node to read.
 * @param layer The layer to read.
 * @returns The neighbours held there.
 *
 * @internal
 */
export function neighborCount(adj: Adjacency, ord: number, layer: number): number {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return 0
  return layerArray(adj, layer)[base]
}

/**
 * Copies a node's neighbours on one layer into a scratch list.
 *
 * @param adj The thread's views over the graph.
 * @param ord The node to read.
 * @param layer The layer to read.
 * @param out The list the neighbours go into.
 * @returns The number of neighbours copied.
 *
 * @internal
 */
export function readNeighbors(adj: Adjacency, ord: number, layer: number, out: Int32Array): number {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return 0
  const array = layerArray(adj, layer)
  const count = Math.min(array[base], out.length)
  for (let i = 0; i < count; i++) out[i] = array[base + i + 1]
  return count
}

/**
 * Reads a node's neighbours on one layer into a fresh array.
 *
 * @param adj The thread's views over the graph.
 * @param ord The node to read.
 * @param layer The layer to read.
 * @returns The neighbour ordinals.
 *
 * @internal
 */
export function collectNeighbors(adj: Adjacency, ord: number, layer: number): number[] {
  const base = layerBase(adj, ord, layer)
  if (base === ABSENT) return []
  const array = layerArray(adj, layer)
  const count = array[base]
  const collected: number[] = new Array(count)
  for (let i = 0; i < count; i++) collected[i] = array[base + i + 1]
  return collected
}

/**
 * Adds one neighbour to a node's list on one layer, keeping the list inside
 * the layer's cap and leaving a neighbour it already holds alone.
 *
 * @param adj The thread's views over the graph.
 * @param ord The node whose list this extends.
 * @param layer The layer the list belongs to.
 * @param neighborOrd The neighbour to add.
 *
 * @internal
 */
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

/**
 * Takes one neighbour out of a node's list on one layer.
 *
 * @param adj The thread's views over the graph.
 * @param ord The node whose list this shortens.
 * @param layer The layer the list belongs to.
 * @param neighborOrd The neighbour to take out.
 *
 * @internal
 */
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

/**
 * Overwrites a node's neighbour list on one layer with the first entries of
 * the given ordinals, keeping no more than the layer's cap.
 *
 * @param adj The adjacency to change.
 * @param ord The node whose list this overwrites.
 * @param layer The layer the list belongs to.
 * @param neighbors The ordinals to write, read from the start.
 * @param count How many of those ordinals to write.
 *
 * @internal
 */
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
