export function magnitude(v: Float32Array): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    sum += v[i] * v[i]
  }
  return Math.sqrt(sum)
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const magA = magnitude(a)
  const magB = magnitude(b)
  if (magA === 0 || magB === 0) return 0

  return dotProduct(a, b) / (magA * magB)
}

export function cosineSimilarityWithMagnitudes(a: Float32Array, b: Float32Array, magA: number, magB: number): number {
  if (magA === 0 || magB === 0) return 0
  return dotProduct(a, b) / (magA * magB)
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i]
  }
  return sum
}

export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i]
    sum += diff * diff
  }
  return Math.sqrt(sum)
}

export function squaredEuclideanDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i]
    sum += diff * diff
  }
  return sum
}
