import { ErrorCodes, NarsilError } from '../errors'
import type { EmbeddingAdapter } from '../types/adapters'
import type { QueryParams, VectorQueryConfig } from '../types/search'

export async function resolveVectorText(
  params: QueryParams,
  embeddingAdapter: EmbeddingAdapter | null,
  signal: AbortSignal,
): Promise<QueryParams> {
  if (!params.vector) return params
  if (params.vector.text === undefined && params.vector.value === undefined) return params
  if (params.vector.value !== undefined && params.vector.text === undefined) return params

  if (params.vector.text !== undefined && params.vector.value !== undefined) {
    throw new NarsilError(ErrorCodes.EMBEDDING_CONFIG_INVALID, "Vector query cannot have both 'text' and 'value'")
  }

  if (!embeddingAdapter) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_CONFIG_INVALID,
      "Vector query with 'text' requires an embedding adapter on the index or instance",
    )
  }

  if (typeof params.vector.text !== 'string') {
    throw new NarsilError(
      ErrorCodes.DOC_VALIDATION_FAILED,
      `Vector query 'text' must be a string, got ${typeof params.vector.text}`,
    )
  }
  if (params.vector.text.length === 0) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, "Vector query 'text' must not be empty")
  }
  const raw = await embeddingAdapter.embed(params.vector.text, 'query', signal)
  if (!(raw instanceof Float32Array)) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_FAILED,
      `Adapter returned ${typeof raw} for query embedding, expected Float32Array`,
    )
  }
  if (raw.length !== embeddingAdapter.dimensions) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_DIMENSION_MISMATCH,
      `Adapter returned ${raw.length}-dimensional vector for query, expected ${embeddingAdapter.dimensions}`,
      { expected: embeddingAdapter.dimensions, actual: raw.length },
    )
  }
  const resolved: VectorQueryConfig = { ...params.vector, value: Array.from(raw) }
  delete resolved.text
  return { ...params, vector: resolved }
}
