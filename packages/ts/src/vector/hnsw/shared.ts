import type { VectorMetric } from '../brute-force'
import type { QuantizerBuildReader, QuantizerSearchReader } from '../osq/types'
import { fixedView } from '../shared-buffers/growable'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance } from '../similarity'
import type { VectorBuildReader, VectorSearchReader, VectorStoreEntry } from '../vector-store'
import { type Adjacency, ensureAdjacencyCapacity, hasNode, nodeLevel } from './adjacency'
import { MAX_LAYER_CAP } from './constants'
import { GRAPH_ENTRY_POINT, GRAPH_NODE_COUNT, GRAPH_TOMBSTONE_COUNT, GRAPH_TOP_LAYER } from './handles'
import type { GraphLocks } from './locks'
import type { HNSWWorkspace } from './workspace'

export interface HNSWConfig {
  /** Each node keeps this many neighbours per layer. */
  m?: number
  /** The builder explores this many candidates while placing each node. */
  efConstruction?: number
  /** The graph ranks by this metric. */
  metric?: VectorMetric
}

export interface SerializedHNSWGraph {
  /** Every search starts at this node, and it is `null` while the graph is empty. */
  entryPoint: string | null
  /** The graph reaches this many layers. */
  maxLayer: number
  /** Each node keeps this many neighbours per layer. */
  m: number
  /** The builder explored this many candidates while placing each node. */
  efConstruction: number
  /** The graph ranks by this metric. */
  metric?: VectorMetric
  /** Each entry holds a document id, its top layer, and its neighbours per layer. */
  nodes: Array<[string, number, Array<[number, string[]]>]>
}

export interface HNSWSearchState {
  readonly dimension: number
  readonly store: VectorSearchReader
  readonly quantizer: QuantizerSearchReader | undefined
  readonly adjacency: Adjacency
  readonly locks: GraphLocks
  readonly header: Int32Array
  tombstones: Uint8Array
  visited: Uint32Array
  visitStamp: number
  readonly workspace: HNSWWorkspace
  readonly neighborScratch: Int32Array
}

export interface HNSWGraphState extends HNSWSearchState {
  readonly store: VectorBuildReader
  readonly quantizer: QuantizerBuildReader | undefined
  readonly M: number
  readonly Mmax0: number
  readonly efCons: number
  readonly buildMetric: VectorMetric
  readonly mL: number
}

export function entryPointOf(state: HNSWSearchState): number {
  return Atomics.load(state.header, GRAPH_ENTRY_POINT)
}

export function topLayerOf(state: HNSWSearchState): number {
  return Atomics.load(state.header, GRAPH_TOP_LAYER)
}

export function nodeCountOf(state: HNSWSearchState): number {
  return Atomics.load(state.header, GRAPH_NODE_COUNT)
}

export function tombstoneCountOf(state: HNSWSearchState): number {
  return Atomics.load(state.header, GRAPH_TOMBSTONE_COUNT)
}

export function ensureCapacity(state: HNSWGraphState, needed: number): void {
  ensureAdjacencyCapacity(state.adjacency, needed)
  ensureVisited(state, needed)
}

export function ensureVisited(state: HNSWSearchState, needed: number): void {
  if (needed <= state.visited.length) return
  let capacity = state.visited.length === 0 ? 16 : state.visited.length
  while (capacity < needed) capacity *= 2
  const next = new Uint32Array(capacity)
  next.set(state.visited)
  state.visited = next
}

export function nextVisitStamp(state: HNSWSearchState): number {
  state.visitStamp++
  if (state.visitStamp === 0xffffffff) {
    state.visited.fill(0)
    state.visitStamp = 1
  }
  return state.visitStamp
}

export function reachTombstone(state: HNSWSearchState, ord: number): boolean {
  if (ord < state.tombstones.length) return true
  if (ord >= state.adjacency.handles.tombstones.byteLength) return false
  state.tombstones = fixedView(state.adjacency.handles.tombstones, Uint8Array)
  return ord < state.tombstones.length
}

export function isTombstoned(state: HNSWSearchState, ord: number): boolean {
  return ord >= 0 && reachTombstone(state, ord) && state.tombstones[ord] === 1
}

export function nodeExists(state: HNSWSearchState, ord: number): boolean {
  return hasNode(state.adjacency, ord)
}

export function nodeMaxLayer(state: HNSWSearchState, ord: number): number {
  return nodeLevel(state.adjacency, ord)
}

export function toDistance(a: Float32Array, b: Float32Array, magA: number, magB: number, metric: VectorMetric): number {
  switch (metric) {
    case 'cosine':
      return 1 - cosineSimilarityWithMagnitudes(a, b, magA, magB)
    case 'dotProduct':
      return -dotProduct(a, b)
    case 'euclidean':
      return euclideanDistance(a, b)
  }
}

export function toScore(distance: number, metric: VectorMetric): number {
  switch (metric) {
    case 'cosine':
      return 1 - distance
    case 'dotProduct':
      return -distance
    case 'euclidean':
      return 1 / (1 + distance)
  }
}

export function randomLevel(mL: number): number {
  let u = Math.random()
  if (u === 0) u = Number.MIN_VALUE
  return Math.min(Math.floor(-Math.log(u) * mL), MAX_LAYER_CAP)
}

export function entryForOrd(state: HNSWSearchState, ord: number): VectorStoreEntry | undefined {
  return state.store.entryForOrdinal(ord)
}

export function buildsFromCodes(state: HNSWSearchState): boolean {
  return activeQuantizer(state) !== undefined
}

export function activeQuantizer(state: HNSWSearchState): QuantizerSearchReader | undefined {
  const quantizer = state.quantizer
  if (quantizer === undefined || !quantizer.isCalibrated()) return undefined
  return quantizer
}

export function nodeDistanceByOrd(state: HNSWGraphState, aOrd: number, bOrd: number, metric: VectorMetric): number {
  if (buildsFromCodes(state) && state.quantizer !== undefined) {
    const estimated = state.quantizer.distanceBetweenOrdinals(aOrd, bOrd)
    if (estimated !== Number.POSITIVE_INFINITY) return estimated
  }
  return state.store.distanceByOrdinal(aOrd, bOrd, metric)
}

export function queryDistanceByOrd(
  state: HNSWSearchState,
  qVec: Float32Array,
  qMag: number,
  ord: number,
  metric: VectorMetric,
): number {
  const entry = state.store.entryForOrdinal(ord)
  if (!entry) return Number.POSITIVE_INFINITY
  return toDistance(qVec, entry.vector, qMag, entry.magnitude, metric)
}

export function maxConns(state: HNSWGraphState, layer: number): number {
  return layer === 0 ? state.Mmax0 : state.M
}

export function addConnection(connections: number[], ord: number): void {
  for (let i = 0; i < connections.length; i++) {
    if (connections[i] === ord) return
  }
  connections.push(ord)
}
