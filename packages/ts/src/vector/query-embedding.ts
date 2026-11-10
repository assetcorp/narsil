import { ErrorCodes, NarsilError } from '../errors'
import type { EmbeddingAdapter } from '../types/adapters'
import type { QueryParams, VectorQueryConfig } from '../types/search'

export async function embedQueryText(
  params: QueryParams,
  vector: VectorQueryConfig,
  embeddingAdapter: EmbeddingAdapter | null,
  signal: AbortSignal,
  embeddingAdapterName?: string | null,
): Promise<QueryParams> {
  if (vector.text !== undefined && vector.value !== undefined) {
    throw new NarsilError(ErrorCodes.EMBEDDING_CONFIG_INVALID, "Vector query cannot have both 'text' and 'value'")
  }

  if (!embeddingAdapter) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_CONFIG_INVALID,
      embeddingAdapterName
        ? `Vector query with 'text' needs embedding adapter "${embeddingAdapterName}", which is not registered on this engine. Register it with registerEmbeddingAdapter or supply a raw vector.`
        : "Vector query with 'text' requires an embedding adapter on the index or instance",
      embeddingAdapterName ? { adapter: embeddingAdapterName } : undefined,
    )
  }

  if (typeof vector.text !== 'string') {
    throw new NarsilError(
      ErrorCodes.DOC_VALIDATION_FAILED,
      `Vector query 'text' must be a string, got ${typeof vector.text}`,
    )
  }
  if (vector.text.length === 0) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, "Vector query 'text' must not be empty")
  }
  let raw: unknown
  try {
    raw = await embeddingAdapter.embed(vector.text, 'query', signal)
  } catch (err) {
    if (err instanceof NarsilError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new NarsilError(ErrorCodes.EMBEDDING_FAILED, `The embedding adapter cannot embed the query: ${message}`, {
      cause: message,
    })
  }
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
  for (let index = 0; index < raw.length; index++) {
    if (Number.isFinite(raw[index])) continue
    throw new NarsilError(
      ErrorCodes.EMBEDDING_FAILED,
      `Adapter returned vector with ${raw[index]} at index ${index} for query embedding`,
      { index },
    )
  }
  const resolved: VectorQueryConfig = { ...vector, value: Array.from(raw) }
  delete resolved.text
  return { ...params, vector: resolved }
}
