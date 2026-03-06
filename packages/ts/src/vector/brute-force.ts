import type { ScoredDocument, VectorEntry } from '../types/internal'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from './similarity'

export type VectorMetric = 'cosine' | 'dotProduct' | 'euclidean'

export interface BruteForceVectorStore {
  readonly dimension: number
  readonly size: number
  insert(docId: string, vector: Float32Array): void
  remove(docId: string): void
  has(docId: string): boolean
  search(
    query: Float32Array,
    k: number,
    metric: VectorMetric,
    minSimilarity: number,
    filterDocIds?: Set<string>,
  ): ScoredDocument[]
  clear(): void
  entries(): IterableIterator<[string, VectorEntry]>
}

export function createBruteForceVectorStore(dimension: number): BruteForceVectorStore {
  const vectors = new Map<string, VectorEntry>()

  return {
    get dimension() {
      return dimension
    },

    get size() {
      return vectors.size
    },

    insert(docId: string, vector: Float32Array): void {
      if (vector.length !== dimension) {
        throw new Error(`Vector dimension mismatch: expected ${dimension}, got ${vector.length}`)
      }
      const mag = magnitude(vector)
      vectors.set(docId, { docId, vector, magnitude: mag })
    },

    remove(docId: string): void {
      vectors.delete(docId)
    },

    has(docId: string): boolean {
      return vectors.has(docId)
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
      const results: Array<{ docId: string; score: number }> = []

      for (const [docId, entry] of vectors) {
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
          results.push({ docId, score })
        }
      }

      results.sort((a, b) => b.score - a.score)
      const topK = results.slice(0, k)

      return topK.map(r => ({
        docId: r.docId,
        score: r.score,
        termFrequencies: {},
        fieldLengths: {},
        idf: {},
      }))
    },

    clear(): void {
      vectors.clear()
    },

    entries(): IterableIterator<[string, VectorEntry]> {
      return vectors.entries()
    },
  }
}
