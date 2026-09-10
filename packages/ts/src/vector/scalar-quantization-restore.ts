import { createScalarQuantizer } from './scalar-quantization'
import type { ScalarQuantizer, SerializedSQ8 } from './scalar-quantization-types'
import type { VectorStore } from './vector-store'

export function deserializeScalarQuantizer(
  data: SerializedSQ8,
  dimensions: number,
  store: VectorStore,
): ScalarQuantizer {
  const quantizer = createScalarQuantizer(dimensions, store)

  if (data.alpha === 0 && data.offset === 0 && Object.keys(data.quantizedVectors).length === 0) {
    return quantizer
  }

  quantizer.restoreCalibration(data.alpha, data.offset)

  for (const [docId, values] of Object.entries(data.quantizedVectors)) {
    if (!store.has(docId)) continue
    const quantized = new Uint8Array(values)
    const sum = data.vectorSums[docId] ?? 0
    const sumSq = data.vectorSumSqs[docId] ?? 0
    quantizer.restoreEntry(docId, quantized, sum, sumSq)
  }

  return quantizer
}
