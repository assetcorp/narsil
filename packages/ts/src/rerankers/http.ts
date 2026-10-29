import { ErrorCodes, NarsilError } from '../errors'
import { type ApiKeySource, buildSignal, postJsonWithRetry, resolveApiKey } from '../http-retry'
import type { RerankAdapter } from '../types/adapters'
import { DEFAULT_MAX_DOCUMENTS_PER_REQUEST, DEFAULT_MAX_RETRIES, DEFAULT_REQUEST_TIMEOUT_MS } from './constants'

const SERVICE = 'Rerank service'

/**
 * How {@link createHttpReranker} reaches a rerank endpoint.
 *
 * @public
 */
export interface HttpRerankerConfig {
  /**
   * The adapter sends each request to this address with `/rerank` added.
   * Give the versioned API address of Cohere or Jina, or the address of a
   * vLLM or Infinity server that you host.
   */
  baseUrl: string
  /** The service scores the documents with this model. */
  model: string
  /**
   * The adapter sends this key as a bearer token. Pass a function to fetch a
   * fresh or short-lived key for every request, and leave the key out for a
   * server that you host without one.
   */
  apiKey?: string | (() => string | Promise<string>)
  /** The adapter aborts a request that takes longer than this many milliseconds, and waits 30,000 by default. */
  timeout?: number
  /** The adapter retries a request this many times, and 3 times by default, when the service answers with status 429, 500, 502, 503, or 504 or the network fails. */
  maxRetries?: number
  /** The adapter sends at most this many documents in one request, and 1,000 by default, splitting a larger list across several requests. */
  maxDocumentsPerRequest?: number
}

function invalid(message: string): NarsilError {
  return new NarsilError(ErrorCodes.RERANK_CONFIG_INVALID, `HTTP rerank adapter ${message}`)
}

function requireConfig(config: HttpRerankerConfig): void {
  if (typeof config?.baseUrl !== 'string' || config.baseUrl.trim().length === 0) {
    throw invalid('requires a non-empty baseUrl')
  }
  let protocol: string
  try {
    protocol = new URL(config.baseUrl).protocol
  } catch {
    throw invalid('requires baseUrl to be an absolute URL')
  }
  if (protocol !== 'https:' && protocol !== 'http:') throw invalid('requires an http or https baseUrl')
  if (typeof config.model !== 'string' || config.model.trim().length === 0) throw invalid('requires a non-empty model')
  if (config.timeout !== undefined && (!Number.isFinite(config.timeout) || config.timeout <= 0)) {
    throw invalid('timeout must be a positive number')
  }
  if (config.maxRetries !== undefined && (!Number.isInteger(config.maxRetries) || config.maxRetries < 0)) {
    throw invalid('maxRetries must be a non-negative integer')
  }
  const perRequest = config.maxDocumentsPerRequest
  if (perRequest !== undefined && (!Number.isInteger(perRequest) || perRequest < 1)) {
    throw invalid('maxDocumentsPerRequest must be a positive integer')
  }
  const apiKey: unknown = config.apiKey
  if (apiKey !== undefined && typeof apiKey !== 'string' && typeof apiKey !== 'function') {
    throw invalid('apiKey must be a string or a function returning a string')
  }
  if (typeof apiKey === 'string' && apiKey.trim().length === 0) throw invalid('requires a non-empty apiKey')
}

function failed(message: string, details?: Record<string, unknown>): NarsilError {
  return new NarsilError(ErrorCodes.RERANK_FAILED, `${SERVICE} ${message}`, details)
}

function scoresFromResults(results: unknown, count: number): number[] {
  if (!Array.isArray(results)) throw failed('response is missing a "results" array')
  if (results.length !== count) {
    throw failed(`returned ${results.length} results for ${count} documents`, {
      expected: count,
      actual: results.length,
    })
  }
  const scores = new Array<number>(count)
  const seen = new Uint8Array(count)
  for (let i = 0; i < results.length; i++) {
    const item: unknown = results[i]
    const index = typeof item === 'object' && item !== null ? (item as { index?: unknown }).index : undefined
    const score =
      typeof item === 'object' && item !== null ? (item as { relevance_score?: unknown }).relevance_score : undefined
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || seen[index] === 1) {
      throw failed(`result at position ${i} carries no index of a document it was sent, or repeats one`)
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw failed(`result at position ${i} carries no finite "relevance_score"`)
    }
    seen[index] = 1
    scores[index] = score
  }
  return scores
}

/**
 * Builds a rerank adapter that calls a Cohere-compatible `/rerank` endpoint,
 * which Cohere, Jina, vLLM, and Infinity serve.
 *
 * The adapter posts the model, the query, and the documents, and reads one
 * `relevance_score` per document from the `results` list. It retries a
 * request on a rate limit, a server error, or a network failure, with an
 * exponential wait and jitter, and it keeps the API key out of every error
 * message.
 *
 * @param config - The endpoint, model, key, and limits.
 * @returns An adapter that you pass in `rerankAdapters` or register with
 * {@link AdapterRegistrationOperations.registerRerankAdapter}.
 * @throws A `NarsilError` with `RERANK_CONFIG_INVALID` when the base URL, the
 * model, the key, or a limit is missing or out of range.
 *
 * @public
 */
export function createHttpReranker(config: HttpRerankerConfig): RerankAdapter {
  requireConfig(config)
  const url = `${config.baseUrl.replace(/\/+$/, '')}/rerank`
  const model = config.model
  const apiKeySource: ApiKeySource | undefined = config.apiKey
  const timeoutMs = config.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
  const perRequest = config.maxDocumentsPerRequest ?? DEFAULT_MAX_DOCUMENTS_PER_REQUEST

  return {
    async rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]> {
      if (documents.length === 0) return []
      const apiKey =
        apiKeySource === undefined
          ? null
          : await resolveApiKey(apiKeySource, 'HTTP rerank adapter', ErrorCodes.RERANK_CONFIG_INVALID)
      const combinedSignal = buildSignal(signal, timeoutMs)
      const scores: number[] = []
      for (let start = 0; start < documents.length; start += perRequest) {
        const chunk = documents.slice(start, start + perRequest)
        const response = await postJsonWithRetry({
          url,
          body: JSON.stringify({ model, query, documents: chunk, top_n: chunk.length }),
          apiKey,
          maxRetries,
          signal: combinedSignal,
          service: SERVICE,
          failureCode: ErrorCodes.RERANK_FAILED,
        })
        for (const score of scoresFromResults(response.results, chunk.length)) scores.push(score)
      }
      return scores
    },

    async shutdown(): Promise<void> {},
  }
}
