import { ErrorCodes, NarsilError } from '../errors'
import { buildSignal, postJsonWithRetry, resolveApiKey } from '../http-retry'
import type { EmbeddingAdapter } from '../types/adapters'
import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_INPUTS_PER_REQUEST } from './constants'

/**
 * How {@link createOpenAIEmbedding} reaches an embeddings endpoint.
 *
 * @public
 */
export interface OpenAIEmbeddingConfig {
  /** This points the adapter at OpenAI, at Azure, or at a compatible service you host. */
  baseUrl: string
  /** This holds the key, or a function returning it, which is how you rotate a key or fetch a short-lived token per request. */
  apiKey: string | (() => string | Promise<string>)
  /** The adapter embeds with this model. */
  model: string
  /** The model returns vectors this long, which must match the schema's `vector[N]`. */
  dimensions: number
  /** The adapter aborts a request that runs longer than this many milliseconds. */
  timeout?: number
  /** The adapter retries this many times when the service rejects a request as retryable, such as on a rate limit. */
  maxRetries?: number
}

interface OpenAIEmbeddingItem {
  index: number
  embedding: number[]
}

function parseEmbeddingItems(data: unknown): OpenAIEmbeddingItem[] {
  if (!Array.isArray(data)) {
    throw new NarsilError(ErrorCodes.EMBEDDING_FAILED, 'OpenAI response missing "data" array')
  }
  const items: OpenAIEmbeddingItem[] = []
  for (let i = 0; i < data.length; i++) {
    const item = data[i] as Record<string, unknown> | undefined
    if (item === undefined || item === null || typeof item !== 'object') {
      throw new NarsilError(ErrorCodes.EMBEDDING_FAILED, `OpenAI response item at position ${i} is not an object`)
    }
    if (typeof item.index !== 'number') {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_FAILED,
        `OpenAI response item at position ${i} missing numeric "index"`,
      )
    }
    if (!Array.isArray(item.embedding)) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_FAILED,
        `OpenAI response item at position ${i} missing "embedding" array`,
      )
    }
    items.push({ index: item.index, embedding: item.embedding as number[] })
  }
  return items
}

/**
 * Builds an embedding adapter that calls an OpenAI-compatible embeddings
 * endpoint, so an index embeds documents as they arrive and embeds a query as
 * it runs.
 *
 * The adapter batches when the engine offers it a batch, retries a request the
 * service says is retryable, and gives up once `maxRetries` is spent.
 *
 * @param config - Endpoint, credentials, model, and vector length.
 * @returns An adapter you pass as `embedding`, or register by name with
 * {@link AdapterRegistrationOperations.registerEmbeddingAdapter}.
 * @throws A `NarsilError` with `EMBEDDING_CONFIG_INVALID` when the base URL,
 * the model, or the dimension count is missing or out of range.
 *
 * @public
 */
export function createOpenAIEmbedding(config: OpenAIEmbeddingConfig): EmbeddingAdapter {
  if (!config.baseUrl || config.baseUrl.trim().length === 0) {
    throw new NarsilError(ErrorCodes.EMBEDDING_CONFIG_INVALID, 'OpenAI embedding adapter requires a non-empty baseUrl')
  }
  if (!config.model || config.model.trim().length === 0) {
    throw new NarsilError(ErrorCodes.EMBEDDING_CONFIG_INVALID, 'OpenAI embedding adapter requires a non-empty model')
  }
  if (!Number.isInteger(config.dimensions) || config.dimensions < 1) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_CONFIG_INVALID,
      'OpenAI embedding adapter requires dimensions to be a positive integer',
    )
  }
  if (config.timeout !== undefined && (!Number.isFinite(config.timeout) || config.timeout <= 0)) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_CONFIG_INVALID,
      'OpenAI embedding adapter timeout must be a positive number',
    )
  }
  if (config.maxRetries !== undefined && (!Number.isInteger(config.maxRetries) || config.maxRetries < 0)) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_CONFIG_INVALID,
      'OpenAI embedding adapter maxRetries must be a non-negative integer',
    )
  }
  if (typeof config.apiKey === 'string' && config.apiKey.trim().length === 0) {
    throw new NarsilError(ErrorCodes.EMBEDDING_CONFIG_INVALID, 'OpenAI embedding adapter requires a non-empty apiKey')
  }
  if (typeof config.apiKey !== 'string' && typeof config.apiKey !== 'function') {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_CONFIG_INVALID,
      'OpenAI embedding adapter apiKey must be a string or a function returning a string',
    )
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`
  const model = config.model
  const dimensionCount = config.dimensions
  const timeoutMs = config.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maxRetries = config.maxRetries ?? 3

  return {
    get dimensions(): number {
      return dimensionCount
    },

    async embed(input: string, _purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array> {
      const apiKey = await resolveApiKey(config.apiKey, 'OpenAI embedding adapter', ErrorCodes.EMBEDDING_CONFIG_INVALID)
      const body = JSON.stringify({ input: [input], model, dimensions: dimensionCount })
      const combinedSignal = buildSignal(signal, timeoutMs)
      const result = await postJsonWithRetry({
        url,
        body,
        apiKey,
        maxRetries,
        signal: combinedSignal,
        service: 'OpenAI',
        failureCode: ErrorCodes.EMBEDDING_FAILED,
      })

      const items = parseEmbeddingItems(result.data)
      if (items.length === 0) {
        throw new NarsilError(
          ErrorCodes.EMBEDDING_FAILED,
          'OpenAI returned empty data array for single embedding request',
        )
      }

      return new Float32Array(items[0].embedding)
    },

    async embedBatch(inputs: string[], _purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]> {
      if (inputs.length === 0) return []

      const apiKey = await resolveApiKey(config.apiKey, 'OpenAI embedding adapter', ErrorCodes.EMBEDDING_CONFIG_INVALID)
      const combinedSignal = buildSignal(signal, timeoutMs)

      const executeChunk = async (chunk: string[]): Promise<Float32Array[]> => {
        const body = JSON.stringify({ input: chunk, model, dimensions: dimensionCount })
        const result = await postJsonWithRetry({
          url,
          body,
          apiKey,
          maxRetries,
          signal: combinedSignal,
          service: 'OpenAI',
          failureCode: ErrorCodes.EMBEDDING_FAILED,
        })

        const items = parseEmbeddingItems(result.data)
        if (items.length !== chunk.length) {
          throw new NarsilError(
            ErrorCodes.EMBEDDING_FAILED,
            `OpenAI returned ${items.length} embeddings for ${chunk.length} inputs`,
            { expected: chunk.length, actual: items.length },
          )
        }

        const sorted = items.slice().sort((a, b) => a.index - b.index)
        return sorted.map(item => new Float32Array(item.embedding))
      }

      if (inputs.length <= MAX_INPUTS_PER_REQUEST) {
        return executeChunk(inputs)
      }

      const results: Float32Array[] = []
      for (let start = 0; start < inputs.length; start += MAX_INPUTS_PER_REQUEST) {
        const chunk = inputs.slice(start, start + MAX_INPUTS_PER_REQUEST)
        const chunkResults = await executeChunk(chunk)
        for (const vec of chunkResults) {
          results.push(vec)
        }
      }
      return results
    },

    async shutdown(): Promise<void> {},
  }
}
