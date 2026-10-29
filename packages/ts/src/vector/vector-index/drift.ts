import type { VectorMetric } from '../brute-force'
import type { OsqQuantizer } from '../osq'
import {
  type CentroidSums,
  centroidOfCentroidSums,
  countOfCentroidSums,
  createCentroidSums,
  meanOfCentroidSums,
  squaredLengthsOfCentroidSums,
} from '../osq/quantize'
import { DRIFT_CHECK_GROWTH_FACTOR, RECALIBRATION_CHUNK_VECTORS } from './constants'
import { liveOrdinals, type VectorIndexState, yieldBuildTurn } from './shared'

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
  const count = countOfCentroidSums(sums)
  let meanSquares = 0
  for (let i = 0; i < mean.length; i++) meanSquares += mean[i] * mean[i]
  return {
    centroid,
    mean,
    meanLength: Math.sqrt(meanSquares),
    count,
    spread: Math.sqrt(Math.max(0, squaredLengthsOfCentroidSums(sums) / count - meanSquares)),
  }
}

export async function measureLiveVectors(
  state: VectorIndexState,
  quantizer: OsqQuantizer,
): Promise<LiveVectorMean | null> {
  const sums = createCentroidSums(state.dimension, state.metric)
  const ordinals = liveOrdinals(state)
  for (let start = 0; start < ordinals.length; start += RECALIBRATION_CHUNK_VECTORS) {
    if (start > 0) await yieldBuildTurn(state)
    if (state.disposed || state.osq !== quantizer) return null
    quantizer.measure(ordinals.subarray(start, start + RECALIBRATION_CHUNK_VECTORS), sums)
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
