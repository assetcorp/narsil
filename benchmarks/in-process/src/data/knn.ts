import { EMBEDDING_DIM } from './vectors'

function dot(a: Float32Array, aOff: number, b: Float32Array, bOff: number, dim: number): number {
  let sum = 0
  for (let i = 0; i < dim; i++) sum += a[aOff + i] * b[bOff + i]
  return sum
}

// Exact top-k by cosine similarity. Vectors are L2-normalized at embed time, so
// cosine reduces to the dot product. Returns, per query, the ids of the k nearest
// documents — the ground truth an approximate (HNSW) index is scored against.
export function exactKnnTopK(
  docVectors: Float32Array,
  docIds: string[],
  queryVectors: Float32Array,
  k: number,
  dim = EMBEDDING_DIM,
): string[][] {
  const docCount = docIds.length
  const queryCount = Math.floor(queryVectors.length / dim)
  const results: string[][] = []
  for (let q = 0; q < queryCount; q++) {
    const qOff = q * dim
    const topScores = new Float64Array(k).fill(Number.NEGATIVE_INFINITY)
    const topIdx = new Int32Array(k).fill(-1)
    for (let d = 0; d < docCount; d++) {
      const score = dot(queryVectors, qOff, docVectors, d * dim, dim)
      if (score <= topScores[k - 1]) continue
      let pos = k - 1
      while (pos > 0 && topScores[pos - 1] < score) {
        topScores[pos] = topScores[pos - 1]
        topIdx[pos] = topIdx[pos - 1]
        pos--
      }
      topScores[pos] = score
      topIdx[pos] = d
    }
    const ids: string[] = []
    for (let i = 0; i < k; i++) {
      const idx = topIdx[i]
      if (idx >= 0) ids.push(docIds[idx])
    }
    results.push(ids)
  }
  return results
}

export function recallAtK(retrieved: string[], groundTruth: string[]): number {
  if (groundTruth.length === 0) return 1
  const truth = new Set(groundTruth)
  let hit = 0
  for (const id of retrieved) {
    if (truth.has(id)) hit++
  }
  return hit / groundTruth.length
}
