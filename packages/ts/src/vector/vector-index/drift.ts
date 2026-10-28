import type { VectorMetric } from '../brute-force'
import {
  addToCentroidSums,
  type CentroidSums,
  centroidOfCentroidSums,
  createCentroidSums,
  meanOfCentroidSums,
} from '../osq/quantize'
import { DRIFT_CHECK_GROWTH_FACTOR, RECALIBRATION_CHUNK_VECTORS } from './constants'
import { type VectorIndexState, yieldBuildTurn } from './shared'

export interface LiveVectorMean {
  readonly centroid: Float32Array
  readonly mean: Float64Array
  readonly meanLength: number
  readonly count: number
  readonly spread: number
}

function liveVectorMeanOf(sums: CentroidSums): LiveVectorMean | null {
  const centroid = centroidOfCentroidSums(sums)
  if (centroid === null) return null
  const mean = meanOfCentroidSums(sums)
  let meanSquares = 0
  for (let i = 0; i < mean.length; i++) meanSquares += mean[i] * mean[i]
  return {
    centroid,
    mean,
    meanLength: Math.sqrt(meanSquares),
    count: sums.count,
    spread: Math.sqrt(Math.max(0, sums.squaredLengths / sums.count - meanSquares)),
  }
}

export async function measureLiveVectors(state: VectorIndexState): Promise<LiveVectorMean | null> {
  const sums = createCentroidSums(state.dimension, state.metric)
  for (let ordinal = 0; ordinal < state.store.slots; ordinal++) {
    if (state.disposed) return null
    const docId = state.store.docIdForOrdinal(ordinal)
    if (docId === undefined || state.tombstones.has(docId)) continue
    const entry = state.store.entryForOrdinal(ordinal)
    if (entry === undefined) continue
    addToCentroidSums(sums, entry.vector)
    if (sums.count % RECALIBRATION_CHUNK_VECTORS === 0) await yieldBuildTurn(state)
  }
  return liveVectorMeanOf(sums)
}

export function driftRatio(
  live: LiveVectorMean,
  calibrated: Float32Array,
  calibratedCount: number,
  calibratedMeanLength: number | null,
  metric: VectorMetric,
): number {
  if (calibratedCount <= 0 || live.count <= calibratedCount) return 0
  const scale = metric === 'cosine' ? (calibratedMeanLength ?? live.meanLength) : 1
  let squares = 0
  for (let i = 0; i < live.mean.length; i++) {
    const difference = live.mean[i] - calibrated[i] * scale
    squares += difference * difference
  }
  const expected = live.spread * Math.sqrt(1 / calibratedCount - 1 / live.count)
  if (expected === 0) return squares === 0 ? 0 : Number.POSITIVE_INFINITY
  return Math.sqrt(squares) / expected
}

export function nextDriftCheck(calibratedCount: number, held: number): number {
  let next = Math.max(1, calibratedCount) * DRIFT_CHECK_GROWTH_FACTOR
  while (next <= held) next *= DRIFT_CHECK_GROWTH_FACTOR
  return next
}
