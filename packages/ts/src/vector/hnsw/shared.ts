import type { VectorMetric } from '../brute-force'
import type { ScalarQuantizer } from '../scalar-quantization'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance } from '../similarity'
import type { VectorStore, VectorStoreEntry } from '../vector-store'

export const MAX_LAYER_CAP = 32
export const COMPACTION_TOMBSTONE_RATIO = 0.1
export const COMPACTION_ABSOLUTE_THRESHOLD = 1000
export const SQ8_OVERSELECTION_FACTOR = 2

export interface HNSWNode {
  docId: string
  maxLayer: number
  connections: Set<string>[]
}

export interface DistancePair {
  docId: string
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
  readonly nodes: Map<string, HNSWNode>
  readonly tombstones: Set<string>
  entryPointId: string | null
  topLayer: number
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

export function getEntry(state: HNSWGraphState, docId: string): VectorStoreEntry | undefined {
  return state.store.get(docId)
}

export function nodeDistance(state: HNSWGraphState, aId: string, bId: string, metric: VectorMetric): number {
  const a = getEntry(state, aId)
  const b = getEntry(state, bId)
  if (!a || !b) return Number.POSITIVE_INFINITY
  return toDistance(a.vector, b.vector, a.magnitude, b.magnitude, metric)
}

export function queryDistance(
  state: HNSWGraphState,
  qVec: Float32Array,
  qMag: number,
  nodeId: string,
  metric: VectorMetric,
): number {
  const entry = getEntry(state, nodeId)
  if (!entry) return Number.POSITIVE_INFINITY
  return toDistance(qVec, entry.vector, qMag, entry.magnitude, metric)
}

export function maxConns(state: HNSWGraphState, layer: number): number {
  return layer === 0 ? state.Mmax0 : state.M
}
