import type { QueryParams } from '@delali/narsil'
import type { BM25Config } from '../scoring'

export const SCORED_RESULT_DEPTH = 50

export function relevanceParams(term: string, excludedFields: string[], config: BM25Config | null): QueryParams {
  const params: QueryParams = { term, limit: SCORED_RESULT_DEPTH, includeScoreComponents: true }
  if (excludedFields.length > 0) params.document = { exclude: excludedFields }
  if (config === null) return params
  params.bm25 = { k1: config.k1, b: config.b }
  if (Object.keys(config.fieldBoosts).length > 0) params.boost = config.fieldBoosts
  return params
}
