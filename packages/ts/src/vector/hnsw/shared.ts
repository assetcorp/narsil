import type { VectorMetric } from '../brute-force'
import type { ScalarQuantizer } from '../scalar-quantization'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance } from '../similarity'
import type { VectorStore, VectorStoreEntry } from '../vector-store'

export const MAX_LAYER_CAP = 32
export const COMPACTION_TOMBSTONE_RATIO = 0.1
export const COMPACTION_ABSOLUTE_THRESHOLD = 1000
export const SQ8_OVERSELECTION_FACTOR = 2

export interface HNSWNode {
  maxLayer: number
  connections: number[][]
}

export interface DistancePair {
  ord: number
  distance: number
}

export interface HNSWConfig {
  m?: number
  efConstruction?: number
  metric?: VectorMetric
}

export interface SerializedHNSWGraph {
  entryPoint: string | null
  maxLayer: number
  m: number
  efConstruction: number
  metric?: VectorMetric
  nodes: Array<[string, number, Array<[number, string[]]>]>
}

export interface HNSWGraphState {
  readonly dimension: number
  readonly store: VectorStore
  readonly quantizer: ScalarQuantizer | undefined
  readonly M: number
  readonly Mmax0: number
  readonly efCons: number
  readonly buildMetric: VectorMetric
  readonly mL: number
  nodesByOrd: Array<HNSWNode | undefined>
  tombstones: Uint8Array
  tombstoneCount: number
  nodeCount: number
  capacity: number
  visited: Uint32Array
  visitStamp: number
  entryPointOrd: number
  topLayer: number
}

export function ensureCapacity(state: HNSWGraphState, needed: number): void {
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

export function nextVisitStamp(state: HNSWGraphState): number {
  state.visitStamp++
  if (state.visitStamp === 0xffffffff) {
    state.visited.fill(0)
    state.visitStamp = 1
  }
  return state.visitStamp
}

export function isTombstoned(state: HNSWGraphState, ord: number): boolean {
  return state.tombstones[ord] === 1
}

export function nodeExists(state: HNSWGraphState, ord: number): boolean {
  return state.nodesByOrd[ord] !== undefined
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

export const distanceAsc = (a: DistancePair, b: DistancePair): number => a.distance - b.distance
export const distanceDesc = (a: DistancePair, b: DistancePair): number => b.distance - a.distance

export function randomLevel(mL: number): number {
  let u = Math.random()
  if (u === 0) u = Number.MIN_VALUE
  return Math.min(Math.floor(-Math.log(u) * mL), MAX_LAYER_CAP)
}

export function entryForOrd(state: HNSWGraphState, ord: number): VectorStoreEntry | undefined {
  return state.store.entryForOrdinal(ord)
}

export function nodeDistanceByOrd(state: HNSWGraphState, aOrd: number, bOrd: number, metric: VectorMetric): number {
  return state.store.distanceByOrdinal(aOrd, bOrd, metric)
}

export function queryDistanceByOrd(
  state: HNSWGraphState,
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
