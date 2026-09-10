import { createScalarQuantizer } from '../../../vector/scalar-quantization'
import type { ScalarQuantizer } from '../../../vector/scalar-quantization-types'
import { magnitude } from '../../../vector/similarity'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'

export const DIM = 16

export function normalizedVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
  }
  const mag = magnitude(v)
  if (mag > 0) {
    for (let i = 0; i < dim; i++) {
      v[i] /= mag
    }
  }
  return v
}

export function vectorFromValues(...values: number[]): Float32Array {
  return new Float32Array(values)
}

/**
 * A quantizer over a store of its own, with a `quantize` that stores the
 * vector first, because the quantizer writes each vector's codes beside the
 * vector the store holds.
 */
export interface QuantizerHarness {
  sq: ScalarQuantizer
  store: VectorStore
  quantize(docId: string, vector: Float32Array): void
  recalibrateAll(vectors: Array<[string, Float32Array]>): void
}

export function createQuantizerHarness(dim: number): QuantizerHarness {
  const store = createVectorStore({ dimension: dim })
  const sq = createScalarQuantizer(dim, store)
  return {
    sq,
    store,
    quantize(docId, vector) {
      store.insert(docId, vector)
      sq.quantize(docId, vector)
    },
    recalibrateAll(vectors) {
      for (const [docId, vector] of vectors) {
        if (!store.has(docId)) store.insert(docId, vector)
      }
      sq.recalibrateAll(vectors)
    },
  }
}
