import { QUANTIZATION_PADDING_FACTOR } from './constants'

export function computeCalibrationBounds(
  vectors: Iterable<Float32Array>,
  dimensions: number,
): { alpha: number; offset: number } | null {
  let globalMin = Number.POSITIVE_INFINITY
  let globalMax = Number.NEGATIVE_INFINITY
  let count = 0

  for (const vec of vectors) {
    for (let d = 0; d < dimensions; d++) {
      const val = vec[d]
      if (val < globalMin) globalMin = val
      if (val > globalMax) globalMax = val
    }
    count++
  }

  if (count === 0) return null

  const range = globalMax - globalMin
  const pad = range * QUANTIZATION_PADDING_FACTOR
  globalMin -= pad
  globalMax += pad

  if (globalMin === globalMax) {
    globalMin -= 0.001
    globalMax += 0.001
  }

  return { alpha: (globalMax - globalMin) / 255, offset: globalMin }
}
