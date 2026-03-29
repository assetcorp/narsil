import { ErrorCodes, NarsilError } from '../errors'
import type { EmbeddingAdapter } from '../types/adapters'

export interface OpenAIEmbeddingConfig {
  baseUrl: string
  apiKey: string | (() => string | Promise<string>)
  model: string
  dimensions: number
  timeout?: number
  maxRetries?: number
}

interface OpenAIEmbeddingItem {
  index: number
  embedding: number[]
}

interface OpenAIErrorBody {
  error?: {
    type?: string
    message?: string
  }
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503])
const MAX_BACKOFF_MS = 30_000
const BASE_BACKOFF_MS = 1_000
const MAX_JITTER_MS = 1_000
const DEFAULT_TIMEOUT_MS = 30_000

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status)
}

function computeBackoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1_000
  }
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  const jitter = Math.random() * MAX_JITTER_MS
  return exponential + jitter
}

function parseRetryAfterHeader(headers: Headers): number | null {
  const raw = headers.get('retry-after')
  if (raw === null) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return seconds
  return null
}

async function resolveApiKey(apiKey: string | (() => string | Promise<string>)): Promise<string> {
  if (typeof apiKey === 'function') {
    return await apiKey()
  }
  return apiKey
}

function buildSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (callerSignal === undefined) return timeoutSignal
  return AbortSignal.any([callerSignal, timeoutSignal])
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error)
      return
    }

    const timer = setTimeout(resolve, ms)

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason as Error)
      },
      { once: true },
    )
  })
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

async function parseErrorBody(response: Response): Promise<{ type: string; message: string }> {
  try {
    const body = (await response.json()) as OpenAIErrorBody
    const errorType = body?.error?.type ?? 'unknown'
    const errorMessage = body?.error?.message ?? `HTTP ${response.status}`
    return { type: errorType, message: errorMessage }
  } catch {
    return { type: 'unknown', message: `HTTP ${response.status}` }
  }
}

async function executeWithRetry(
  url: string,
  requestBody: string,
  apiKey: string,
  maxRetries: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal,
      })
    } catch (err: unknown) {
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw err
      }
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxRetries) {
        await sleep(computeBackoffMs(attempt, null), signal)
        continue
      }
      throw new NarsilError(
        ErrorCodes.EMBEDDING_FAILED,
        `OpenAI request failed after ${maxRetries + 1} attempts: network error`,
        {
          cause: lastError.message,
        },
      )
    }

    if (response.ok) {
      let parsed: unknown
      try {
        parsed = await response.json()
      } catch {
        throw new NarsilError(ErrorCodes.EMBEDDING_FAILED, 'OpenAI returned invalid JSON in response body')
      }
      if (parsed === null || typeof parsed !== 'object') {
        throw new NarsilError(ErrorCodes.EMBEDDING_FAILED, 'OpenAI returned non-object JSON response')
      }
      return parsed as Record<string, unknown>
    }

    const retryAfter = parseRetryAfterHeader(response.headers)
    const errorInfo = await parseErrorBody(response)

    if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_FAILED,
        `OpenAI API error (${response.status}): [${errorInfo.type}] ${errorInfo.message}`,
        { status: response.status, errorType: errorInfo.type },
      )
    }

    lastError = new Error(`HTTP ${response.status}: ${errorInfo.type}`)
    await sleep(computeBackoffMs(attempt, retryAfter), signal)
  }

  throw new NarsilError(ErrorCodes.EMBEDDING_FAILED, 'OpenAI request failed: exhausted all retries', {
    cause: lastError?.message,
  })
}

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

  const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`
  const model = config.model
  const dimensionCount = config.dimensions
  const timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS
  const maxRetries = config.maxRetries ?? 3

  return {
    get dimensions(): number {
      return dimensionCount
    },

    async embed(input: string, _purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array> {
      const apiKey = await resolveApiKey(config.apiKey)
      const body = JSON.stringify({ input: [input], model, dimensions: dimensionCount })
      const combinedSignal = buildSignal(signal, timeoutMs)
      const result = await executeWithRetry(url, body, apiKey, maxRetries, combinedSignal)

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

      const apiKey = await resolveApiKey(config.apiKey)
      const body = JSON.stringify({ input: inputs, model, dimensions: dimensionCount })
      const combinedSignal = buildSignal(signal, timeoutMs)
      const result = await executeWithRetry(url, body, apiKey, maxRetries, combinedSignal)

      const items = parseEmbeddingItems(result.data)
      if (items.length !== inputs.length) {
        throw new NarsilError(
          ErrorCodes.EMBEDDING_FAILED,
          `OpenAI returned ${items.length} embeddings for ${inputs.length} inputs`,
          { expected: inputs.length, actual: items.length },
        )
      }

      const sorted = items.slice().sort((a, b) => a.index - b.index)
      return sorted.map(item => new Float32Array(item.embedding))
    },

    async shutdown(): Promise<void> {},
  }
}
