import type { VectorMetric } from '../brute-force'
import type { QuantizerSearchReader, ScalarQuantizer } from '../scalar-quantization-types'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance } from '../similarity'
import type { VectorSearchReader, VectorStore, VectorStoreEntry } from '../vector-store'
import { type Adjacency, ensureAdjacencyCapacity, hasNode, nodeLevel } from './adjacency'
import { MAX_LAYER_CAP } from './constants'
import type { HNSWWorkspace } from './workspace'

/**
 * How an HNSW graph is built.
 *
 * @internal
 */
export interface HNSWConfig {
  /** Each node keeps this many neighbours per layer. */
  m?: number
  /** The builder explores this many candidates while placing each node. */
  efConstruction?: number
  /** The graph ranks by this metric. */
  metric?: VectorMetric
}

/**
 * An HNSW graph in the form the engine passes between threads.
 *
 * @internal
 */
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

/**
 * The graph state a search reads, without the mutation-only members.
 *
 * A worker searching a shared copy builds this over read-only views, with its
 * own visited array, and the full {@link HNSWGraphState} satisfies it on the
 * main thread, so one search implementation serves both.
 *
 * @internal
 */
export interface HNSWSearchState {
  readonly dimension: number
  readonly store: VectorSearchReader
  readonly quantizer: QuantizerSearchReader | undefined
  adjacency: Adjacency
  tombstones: Uint8Array
  tombstoneCount: number
  nodeCount: number
  capacity: number
  visited: Uint32Array
  visitStamp: number
  entryPointOrd: number
  topLayer: number
  readonly workspace: HNSWWorkspace
}

export interface HNSWGraphState extends HNSWSearchState {
  readonly store: VectorStore
  readonly quantizer: ScalarQuantizer | undefined
  readonly M: number
  readonly Mmax0: number
  readonly efCons: number
  readonly buildMetric: VectorMetric
  readonly mL: number
}

export function ensureCapacity(state: HNSWGraphState, needed: number): void {
  ensureAdjacencyCapacity(state.adjacency, needed)
  if (needed <= state.capacity) return
  let newCap = state.capacity === 0 ? 16 : state.capacity
  while (newCap < needed) newCap *= 2
  const nextTombstones = new Uint8Array(newCap)
  nextTombstones.set(state.tombstones)
  state.tombstones = nextTombstones
  state.visited = new Uint32Array(newCap)
  state.visitStamp = 0
  state.capacity = newCap
}

export function nextVisitStamp(state: HNSWSearchState): number {
  state.visitStamp++
  if (state.visitStamp === 0xffffffff) {
    state.visited.fill(0)
    state.visitStamp = 1
  }
  return state.visitStamp
}

export function isTombstoned(state: HNSWSearchState, ord: number): boolean {
  return state.tombstones[ord] === 1
}

export function nodeExists(state: HNSWSearchState, ord: number): boolean {
  return hasNode(state.adjacency, ord)
}

export function nodeMaxLayer(state: HNSWGraphState, ord: number): number {
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

export function nodeDistanceByOrd(state: HNSWGraphState, aOrd: number, bOrd: number, metric: VectorMetric): number {
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
