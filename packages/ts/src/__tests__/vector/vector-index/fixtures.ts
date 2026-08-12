export const DIM = 4

export function vectorFromValues(...values: number[]): Float32Array {
  return new Float32Array(values)
}

export function seededVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
  }
  return v
}

export function normalizedVector(dim: number, seed: number): Float32Array {
  const v = seededVector(dim, seed)
  let sumSq = 0
  for (let i = 0; i < dim; i++) sumSq += v[i] * v[i]
  const mag = Math.sqrt(sumSq)
  if (mag === 0) return v
  for (let i = 0; i < dim; i++) v[i] /= mag
  return v
}
