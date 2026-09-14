import { fixedView, growBufferTo } from '../../shared-buffers/growable'
import { GRAPH_SLOTS, GRAPH_UPPER_USED, type SharedGraphHandles } from '../handles'

export const ABSENT = -1

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

export function rebindNodes(adj: Adjacency): void {
  adj.nodeLevels = fixedView(adj.handles.nodeLevels, Uint8Array)
  adj.level0 = fixedView(adj.handles.level0, Int32Array)
  adj.upperBase = fixedView(adj.handles.upperBase, Int32Array)
}

function rebindUpper(adj: Adjacency): void {
  adj.upper = fixedView(adj.handles.upper, Int32Array)
}

export function reachNode(adj: Adjacency, ord: number): boolean {
  if (ord < adj.nodeLevels.length) return true
  if (ord >= adj.handles.nodeLevels.byteLength) return false
  rebindNodes(adj)
  return ord < adj.nodeLevels.length
}

export function reachUpper(adj: Adjacency, end: number): boolean {
  if (end <= adj.upper.length) return true
  if (end * 4 > adj.handles.upper.byteLength) return false
  rebindUpper(adj)
  return end <= adj.upper.length
}

export function adjacencyCapacity(adj: Adjacency): number {
  return adj.nodeLevels.length
}

export function adjacencySlots(adj: Adjacency): number {
  return Atomics.load(adj.header, GRAPH_SLOTS)
}

export function upperUsed(adj: Adjacency): number {
  return Atomics.load(adj.header, GRAPH_UPPER_USED)
}

export function ensureAdjacencyCapacity(adj: Adjacency, needed: number): void {
  if (needed <= adj.nodeLevels.length) return
  const capacity = Math.max(needed, adj.handles.nodeLevels.byteLength * 2)
  growBufferTo(adj.handles.level0, capacity * adj.level0Stride * 4)
  growBufferTo(adj.handles.upperBase, capacity * 4)
  growBufferTo(adj.handles.locks, capacity * 4)
  growBufferTo(adj.handles.tombstones, capacity)
  growBufferTo(adj.handles.nodeLevels, capacity)
  rebindNodes(adj)
}

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

export function createNode(adj: Adjacency, ord: number, maxLayer: number): void {
  ensureAdjacencyCapacity(adj, ord + 1)
  adj.upperBase[ord] = maxLayer >= 1 ? allocateUpperBlock(adj, maxLayer) + 1 : 0
  adj.level0[ord * adj.level0Stride] = 0
  raiseSlots(adj, ord + 1)
  Atomics.store(adj.nodeLevels, ord, maxLayer + 1)
}

export function deleteNode(adj: Adjacency, ord: number): void {
  if (ord < 0 || !reachNode(adj, ord)) return
  Atomics.store(adj.nodeLevels, ord, 0)
  adj.upperBase[ord] = 0
  adj.level0[ord * adj.level0Stride] = 0
}

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

export function nodeLevel(adj: Adjacency, ord: number): number {
  if (ord < 0 || !reachNode(adj, ord)) return ABSENT
  return adj.nodeLevels[ord] - 1
}

export function hasNode(adj: Adjacency, ord: number): boolean {
  return nodeLevel(adj, ord) !== ABSENT
}

export function graphBytes(adj: Adjacency): number {
  const handles = adj.handles
  return (
    handles.header.byteLength +
    handles.nodeLevels.byteLength +
    handles.level0.byteLength +
    handles.upperBase.byteLength +
    handles.upper.byteLength +
    handles.locks.byteLength +
    handles.tombstones.byteLength +
    handles.heldLocks.byteLength
  )
}
