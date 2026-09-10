import { fixedView, growBufferTo } from '../../shared-buffers/growable'
import { GRAPH_SLOTS, GRAPH_UPPER_USED, type SharedGraphHandles } from '../handles'

export const ABSENT = -1

/**
 * These are one thread's views over a graph's shared adjacency arrays. Each
 * view spans the bytes its buffer held when the thread last looked, and the
 * thread rebuilds a view once an ordinal or an arena offset falls beyond it,
 * which happens only after another thread has grown the buffer.
 *
 * The adjacency stores levels and upper bases one above their value, so that
 * the zero a freshly grown region holds reads as absent.
 *
 * @internal
 */
export interface Adjacency {
  readonly m: number
  readonly mMax0: number
  readonly level0Stride: number
  readonly upperStride: number
  readonly handles: SharedGraphHandles
  readonly header: Int32Array
  nodeLevels: Uint8Array
  level0: Int32Array
  upperBase: Int32Array
  upper: Int32Array
}

/**
 * Opens a graph's adjacency arrays on the current thread.
 *
 * @param handles The graph whose arrays to open.
 * @param m The neighbours each node keeps on an upper layer.
 * @param mMax0 The neighbours each node keeps on the base layer.
 * @returns The thread's views over those arrays.
 *
 * @internal
 */
export function openAdjacency(handles: SharedGraphHandles, m: number, mMax0: number): Adjacency {
  return {
    m,
    mMax0,
    level0Stride: mMax0 + 2,
    upperStride: m + 2,
    handles,
    header: handles.header,
    nodeLevels: fixedView(handles.nodeLevels, Uint8Array),
    level0: fixedView(handles.level0, Int32Array),
    upperBase: fixedView(handles.upperBase, Int32Array),
    upper: fixedView(handles.upper, Int32Array),
  }
}

/**
 * Rebuilds the per-ordinal views once their buffers have grown.
 *
 * @param adj The thread's views over the graph.
 *
 * @internal
 */
export function rebindNodes(adj: Adjacency): void {
  adj.nodeLevels = fixedView(adj.handles.nodeLevels, Uint8Array)
  adj.level0 = fixedView(adj.handles.level0, Int32Array)
  adj.upperBase = fixedView(adj.handles.upperBase, Int32Array)
}

function rebindUpper(adj: Adjacency): void {
  adj.upper = fixedView(adj.handles.upper, Int32Array)
}

/**
 * Reports whether this thread's node views reach an ordinal, rebuilding them
 * once another thread has grown the buffers behind them.
 *
 * @param adj The thread's views over the graph.
 * @param ord The ordinal to reach.
 * @returns True where the views span it.
 *
 * @internal
 */
export function reachNode(adj: Adjacency, ord: number): boolean {
  if (ord < adj.nodeLevels.length) return true
  if (ord >= adj.handles.nodeLevels.byteLength) return false
  rebindNodes(adj)
  return ord < adj.nodeLevels.length
}

/**
 * Reports whether this thread's upper-layer view reaches an arena entry,
 * rebuilding it once another thread has grown the buffer behind it.
 *
 * @param adj The thread's views over the graph.
 * @param end The entry the caller reads up to.
 * @returns True where the view spans it.
 *
 * @internal
 */
export function reachUpper(adj: Adjacency, end: number): boolean {
  if (end <= adj.upper.length) return true
  if (end * 4 > adj.handles.upper.byteLength) return false
  rebindUpper(adj)
  return end <= adj.upper.length
}

/**
 * Reports how many ordinals this thread's views span.
 *
 * @param adj The thread's views over the graph.
 * @returns The ordinals the views reach.
 *
 * @internal
 */
export function adjacencyCapacity(adj: Adjacency): number {
  return adj.nodeLevels.length
}

/**
 * Reports how many ordinals the graph has taken, tombstoned ones included.
 *
 * @param adj The thread's views over the graph.
 * @returns The ordinals in use.
 *
 * @internal
 */
export function adjacencySlots(adj: Adjacency): number {
  return Atomics.load(adj.header, GRAPH_SLOTS)
}

/**
 * Reports how many entries of the upper-layer arena the graph has taken.
 *
 * @param adj The thread's views over the graph.
 * @returns The entries in use.
 *
 * @internal
 */
export function upperUsed(adj: Adjacency): number {
  return Atomics.load(adj.header, GRAPH_UPPER_USED)
}

/**
 * Grows the per-ordinal arrays so that they span the given ordinals.
 *
 * @param adj The thread's views over the graph.
 * @param needed The ordinals the arrays must span afterwards.
 *
 * @internal
 */
export function ensureAdjacencyCapacity(adj: Adjacency, needed: number): void {
  if (needed <= adj.nodeLevels.length) return
  growBufferTo(adj.handles.nodeLevels, needed)
  growBufferTo(adj.handles.level0, needed * adj.level0Stride * 4)
  growBufferTo(adj.handles.upperBase, needed * 4)
  growBufferTo(adj.handles.locks, needed * 4)
  growBufferTo(adj.handles.tombstones, needed)
  rebindNodes(adj)
}

/**
 * Grows the upper-layer arena so that it holds the given entries, and rebuilds
 * this thread's view over it.
 *
 * @param adj The thread's views over the graph.
 * @param entries The entries the arena must hold afterwards.
 *
 * @internal
 */
export function ensureUpperCapacity(adj: Adjacency, entries: number): void {
  growBufferTo(adj.handles.upper, entries * 4)
  rebindUpper(adj)
}

function allocateUpperBlock(adj: Adjacency, levels: number): number {
  const size = levels * adj.upperStride
  const offset = Atomics.add(adj.header, GRAPH_UPPER_USED, size)
  growBufferTo(adj.handles.upper, (offset + size) * 4)
  rebindUpper(adj)
  return offset
}

function raiseSlots(adj: Adjacency, slots: number): void {
  for (;;) {
    const seen = Atomics.load(adj.header, GRAPH_SLOTS)
    if (seen >= slots) return
    if (Atomics.compareExchange(adj.header, GRAPH_SLOTS, seen, slots) === seen) return
  }
}

/**
 * Creates a node at an ordinal with the given top layer, publishing it to
 * other threads only once its upper-layer block is in place.
 *
 * @param adj The thread's views over the graph.
 * @param ord The ordinal the node takes.
 * @param maxLayer The top layer the node reaches.
 *
 * @internal
 */
export function createNode(adj: Adjacency, ord: number, maxLayer: number): void {
  ensureAdjacencyCapacity(adj, ord + 1)
  adj.upperBase[ord] = maxLayer >= 1 ? allocateUpperBlock(adj, maxLayer) + 1 : 0
  adj.level0[ord * adj.level0Stride] = 0
  raiseSlots(adj, ord + 1)
  Atomics.store(adj.nodeLevels, ord, maxLayer + 1)
}

/**
 * Cuts the node at an ordinal out of the graph, leaving its neighbours' lists
 * to the caller.
 *
 * @param adj The thread's views over the graph.
 * @param ord The ordinal to clear.
 *
 * @internal
 */
export function deleteNode(adj: Adjacency, ord: number): void {
  if (ord < 0 || !reachNode(adj, ord)) return
  Atomics.store(adj.nodeLevels, ord, 0)
  adj.upperBase[ord] = 0
  adj.level0[ord * adj.level0Stride] = 0
}

/**
 * Empties the graph in place, keeping its buffers.
 *
 * @param adj The thread's views over the graph.
 *
 * @internal
 */
export function resetAdjacency(adj: Adjacency): void {
  rebindNodes(adj)
  rebindUpper(adj)
  adj.nodeLevels.fill(0)
  adj.level0.fill(0)
  adj.upperBase.fill(0)
  adj.upper.fill(0)
  Atomics.store(adj.header, GRAPH_UPPER_USED, 0)
  Atomics.store(adj.header, GRAPH_SLOTS, 0)
}

/**
 * Reports the top layer a node reaches.
 *
 * @param adj The thread's views over the graph.
 * @param ord The ordinal to read.
 * @returns The top layer, or -1 where the graph holds no node there.
 *
 * @internal
 */
export function nodeLevel(adj: Adjacency, ord: number): number {
  if (ord < 0 || !reachNode(adj, ord)) return ABSENT
  return adj.nodeLevels[ord] - 1
}

/**
 * Reports whether the graph holds a node at an ordinal.
 *
 * @param adj The thread's views over the graph.
 * @param ord The ordinal to read.
 * @returns True where a node lies there.
 *
 * @internal
 */
export function hasNode(adj: Adjacency, ord: number): boolean {
  return nodeLevel(adj, ord) !== ABSENT
}

/**
 * Reports the bytes this thread's adjacency views span.
 *
 * @param adj The thread's views over the graph.
 * @returns The bytes the four arrays hold together.
 *
 * @internal
 */
export function estimateAdjacencyBytes(adj: Adjacency): number {
  return adj.nodeLevels.byteLength + adj.level0.byteLength + adj.upperBase.byteLength + adj.upper.byteLength
}
