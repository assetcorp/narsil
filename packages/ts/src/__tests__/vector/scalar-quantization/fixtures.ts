import { magnitude } from '../../../vector/similarity'

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
