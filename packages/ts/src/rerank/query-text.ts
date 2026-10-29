import type { QueryParams } from '../types/search'

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export function rerankQueryTextOf(params: QueryParams): string | undefined {
  const rerank: unknown = params.rerank
  if (typeof rerank === 'object' && rerank !== null && 'query' in rerank && rerank.query !== undefined) {
    return nonBlank(rerank.query)
  }
  return nonBlank(params.term) ?? nonBlank(params.vector?.text)
}

export function withRerankQueryText(params: QueryParams): QueryParams {
  const rerank = params.rerank
  if (rerank === undefined || typeof rerank !== 'object' || rerank === null || rerank.query !== undefined) {
    return params
  }
  const query = rerankQueryTextOf(params)
  return query === undefined ? params : { ...params, rerank: { ...rerank, query } }
}
