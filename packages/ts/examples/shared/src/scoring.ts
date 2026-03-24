import type { QueryHit } from './backend'

export interface BM25Config {
  k1: number
  b: number
  fieldBoosts: Record<string, number>
}

export const DEFAULT_BM25_CONFIG: BM25Config = {
  k1: 1.2,
  b: 0.75,
  fieldBoosts: {},
}

export interface RecomputedHit {
  hit: QueryHit
  originalScore: number
  recomputedScore: number
  originalRank: number
  recomputedRank: number
  fieldScores: Record<string, number>
}

interface FieldAverages {
  avgFieldLengths: Record<string, number>
  totalDocs: number
}

export function computeFieldAverages(hits: QueryHit[]): FieldAverages {
  if (hits.length === 0) {
    return { avgFieldLengths: {}, totalDocs: 0 }
  }

  const fieldLengthSums: Record<string, number> = {}
  const fieldCounts: Record<string, number> = {}

  for (const hit of hits) {
    const components = hit.scoreComponents
    if (!components) continue
    for (const [field, length] of Object.entries(components.fieldLengths)) {
      fieldLengthSums[field] = (fieldLengthSums[field] ?? 0) + length
      fieldCounts[field] = (fieldCounts[field] ?? 0) + 1
    }
  }

  const avgFieldLengths: Record<string, number> = {}
  for (const field of Object.keys(fieldLengthSums)) {
    avgFieldLengths[field] = fieldLengthSums[field] / fieldCounts[field]
  }

  return { avgFieldLengths, totalDocs: hits.length }
}

function computeBM25FieldScore(
  tf: number,
  idf: number,
  fieldLength: number,
  avgFieldLength: number,
  k1: number,
  b: number
): number {
  if (avgFieldLength === 0) return 0
  const numerator = tf * (k1 + 1)
  const denominator = tf + k1 * (1 - b + b * (fieldLength / avgFieldLength))
  return idf * (numerator / denominator)
}

export function recomputeScores(
  hits: QueryHit[],
  config: BM25Config,
  fieldAverages: FieldAverages
): RecomputedHit[] {
  const scored = hits.map((hit, index) => {
    const components = hit.scoreComponents
    if (!components) {
      return {
        hit,
        originalScore: hit.score,
        recomputedScore: hit.score,
        originalRank: index + 1,
        recomputedRank: 0,
        fieldScores: {},
      }
    }

    const fieldScores: Record<string, number> = {}
    let totalScore = 0

    for (const [compoundKey, tf] of Object.entries(components.termFrequencies)) {
      const colonIndex = compoundKey.indexOf(':')
      if (colonIndex === -1) continue

      const fieldName = compoundKey.slice(0, colonIndex)
      const token = compoundKey.slice(colonIndex + 1)

      const idf = components.idf[token] ?? 0
      const fieldLength = components.fieldLengths[fieldName] ?? 0
      const avgFieldLength = fieldAverages.avgFieldLengths[fieldName] ?? 1

      const raw = computeBM25FieldScore(tf, idf, fieldLength, avgFieldLength, config.k1, config.b)
      const boost = config.fieldBoosts[fieldName] ?? 1
      const boosted = raw * boost

      fieldScores[fieldName] = (fieldScores[fieldName] ?? 0) + boosted
      totalScore += boosted
    }

    return {
      hit,
      originalScore: hit.score,
      recomputedScore: totalScore,
      originalRank: index + 1,
      recomputedRank: 0,
      fieldScores,
    }
  })

  scored.sort((a, b) => b.recomputedScore - a.recomputedScore)
  for (let i = 0; i < scored.length; i++) {
    scored[i].recomputedRank = i + 1
  }

  return scored
}
