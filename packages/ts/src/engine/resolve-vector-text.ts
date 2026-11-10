import type { EmbeddingAdapter } from '../types/adapters'
import type { QueryParams } from '../types/search'
import { loadVectorCode } from '../workers/vector-code'

export async function resolveVectorText(
  params: QueryParams,
  embeddingAdapter: EmbeddingAdapter | null,
  signal: AbortSignal,
  embeddingAdapterName?: string | null,
): Promise<QueryParams> {
  if (!params.vector || params.vector.text === undefined) return params
  return (await loadVectorCode()).embedQueryText(params, params.vector, embeddingAdapter, signal, embeddingAdapterName)
}
