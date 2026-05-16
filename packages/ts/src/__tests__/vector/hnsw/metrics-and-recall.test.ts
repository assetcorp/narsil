import { describe, expect, it } from 'vitest'
import { createHNSWIndex } from '../../../vector/hnsw'
import { magnitude } from '../../../vector/similarity'
import { createVectorStore } from '../../../vector/vector-store'
import { DIM, insertVec, normalizedVector, vectorFromValues } from './fixtures'

describe('HNSWIndex search with different metrics', () => {
  it('searches with euclidean distance', () => {
    const eucStore = createVectorStore()
    const eucIndex = createHNSWIndex(DIM, eucStore, { m: 4, efConstruction: 32, metric: 'euclidean' })
    const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
    const near = vectorFromValues(1.1, 0.1, 0, 0, 0, 0, 0, 0)
    const far = vectorFromValues(5, 5, 5, 5, 5, 5, 5, 5)

    insertVec(eucStore, eucIndex, 'near', near)
    insertVec(eucStore, eucIndex, 'far', far)

    const results = eucIndex.search(target, 1, 'euclidean', 0)
    expect(results).toHaveLength(1)
    expect(results[0].docId).toBe('near')
    expect(results[0].score).toBeGreaterThan(0)
  })

  it('searches with dot product', () => {
    const dpStore = createVectorStore()
    const dpIndex = createHNSWIndex(DIM, dpStore, { m: 4, efConstruction: 32, metric: 'dotProduct' })
    const target = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0)
    const highDp = vectorFromValues(10, 0, 0, 0, 0, 0, 0, 0)
    const lowDp = vectorFromValues(0, 10, 0, 0, 0, 0, 0, 0)

    insertVec(dpStore, dpIndex, 'highDp', highDp)
    insertVec(dpStore, dpIndex, 'lowDp', lowDp)

    const results = dpIndex.search(target, 1, 'dotProduct', -Infinity)
    expect(results).toHaveLength(1)
    expect(results[0].docId).toBe('highDp')
  })
})

describe('HNSWIndex recall quality', () => {
  it('achieves high recall on moderate dataset', () => {
    const recallStore = createVectorStore()
    const recallIndex = createHNSWIndex(32, recallStore, { m: 16, efConstruction: 100, metric: 'cosine' })
    const vectors = new Map<string, Float32Array>()
    const count = 500

    for (let i = 0; i < count; i++) {
      const v = normalizedVector(32)
      vectors.set(`doc${i}`, v)
      insertVec(recallStore, recallIndex, `doc${i}`, v)
    }

    const query = normalizedVector(32)
    const hnswResults = recallIndex.search(query, 10, 'cosine', 0, undefined, 64)
    const hnswDocIds = new Set(hnswResults.map(r => r.docId))

    const bruteForceResults: Array<{ docId: string; score: number }> = []
    for (const [docId, v] of vectors) {
      let score = 0
      const qMag = magnitude(query)
      const vMag = magnitude(v)
      if (qMag > 0 && vMag > 0) {
        let dp = 0
        for (let i = 0; i < query.length; i++) dp += query[i] * v[i]
        score = dp / (qMag * vMag)
      }
      bruteForceResults.push({ docId, score })
    }
    bruteForceResults.sort((a, b) => b.score - a.score)
    const trueTop10 = new Set(bruteForceResults.slice(0, 10).map(r => r.docId))

    let matches = 0
    for (const docId of trueTop10) {
      if (hnswDocIds.has(docId)) matches++
    }
    const recall = matches / trueTop10.size

    expect(recall).toBeGreaterThanOrEqual(0.7)
  })
})
