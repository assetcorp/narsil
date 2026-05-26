export const DIM = 4

export function vectorFromValues(...values: number[]): Float32Array {
  return new Float32Array(values)
}

export function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1
  }
  return v
}

export function normalizedVector(dim: number): Float32Array {
  const v = randomVector(dim)
  let sumSq = 0
  for (let i = 0; i < dim; i++) sumSq += v[i] * v[i]
  const mag = Math.sqrt(sumSq)
  if (mag === 0) return v
  for (let i = 0; i < dim; i++) v[i] /= mag
  return v
}
