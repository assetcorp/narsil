import { createScalarQuantizer } from './scalar-quantization'
import type { OrdinalSource, ScalarQuantizer, SerializedSQ8 } from './scalar-quantization-types'

export function deserializeScalarQuantizer(
  data: SerializedSQ8,
  dimensions: number,
  ordinalSource?: OrdinalSource,
): ScalarQuantizer {
  const quantizer = createScalarQuantizer(dimensions, ordinalSource)

  if (data.alpha === 0 && data.offset === 0 && Object.keys(data.quantizedVectors).length === 0) {
    return quantizer
  }

  quantizer.restoreCalibration(data.alpha, data.offset)

  for (const [docId, values] of Object.entries(data.quantizedVectors)) {
    const quantized = new Uint8Array(values)
    const sum = data.vectorSums[docId] ?? 0
    const sumSq = data.vectorSumSqs[docId] ?? 0
    quantizer.restoreEntry(docId, quantized, sum, sumSq)
  }

  return quantizer
}
