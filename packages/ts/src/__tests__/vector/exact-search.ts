import { createBoundedMaxHeap } from '../../core/heap'
import { compareCodePoints } from '../../core/ordering'
import type { ScoredDocument } from '../../types/internal'
import type { VectorMetric } from '../../vector/brute-force'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from '../../vector/similarity'
import type { VectorStore } from '../../vector/vector-store'

export interface ExactSearch {
  readonly dimension: number
  search(
    query: Float32Array,
    k: number,
    metric: VectorMetric,
    minSimilarity: number,
    filterDocIds?: Set<string>,
  ): ScoredDocument[]
}

export function createExactSearch(dimension: number, store: VectorStore): ExactSearch {
  return {
    get dimension() {
      return dimension
    },

    search(
      query: Float32Array,
      k: number,
      metric: VectorMetric,
      minSimilarity: number,
      filterDocIds?: Set<string>,
    ): ScoredDocument[] {
      if (query.length !== dimension) {
        throw new Error(`Query dimension mismatch: expected ${dimension}, got ${query.length}`)
      }
      const queryMag = magnitude(query)
      const highScoreFirst = (a: { score: number; docId: string }, b: { score: number; docId: string }) =>
        b.score - a.score || compareCodePoints(a.docId, b.docId)
      const heap = createBoundedMaxHeap<{ docId: string; score: number }>(highScoreFirst, k)

      for (const [docId, entry] of store.entries()) {
        if (filterDocIds && !filterDocIds.has(docId)) continue

        let score: number
        switch (metric) {
          case 'cosine':
            score = cosineSimilarityWithMagnitudes(query, entry.vector, queryMag, entry.magnitude)
            break
          case 'dotProduct':
            score = dotProduct(query, entry.vector)
            break
          case 'euclidean': {
            const dist = euclideanDistance(query, entry.vector)
            score = 1 / (1 + dist)
            break
          }
        }

        if (score >= minSimilarity) {
          heap.push({ docId, score })
        }
      }

      return heap
        .toSortedArray()
        .reverse()
        .map(r => ({
          docId: r.docId,
          score: r.score,
          termFrequencies: {},
          fieldLengths: {},
          idf: {},
        }))
    },
  }
}
