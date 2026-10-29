import { type ErrorCode, NarsilError } from '../errors'
import { BASE_BACKOFF_MS, MAX_BACKOFF_MS, MAX_JITTER_MS, RETRYABLE_STATUS_CODES } from './constants'

export type ApiKeySource = string | (() => string | Promise<string>)

export interface RetryingPost {
  url: string
  body: string
  apiKey: string | null
  maxRetries: number
  signal: AbortSignal
  service: string
  failureCode: ErrorCode
}

interface ServiceErrorBody {
  error?: { type?: unknown; message?: unknown } | unknown
  message?: unknown
  detail?: unknown
}

function computeBackoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1_000, MAX_BACKOFF_MS)
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

export async function resolveApiKey(apiKey: ApiKeySource, service: string, invalidCode: ErrorCode): Promise<string> {
  const resolved = typeof apiKey === 'function' ? await apiKey() : apiKey
  if (typeof resolved !== 'string' || resolved.trim().length === 0) {
    throw new NarsilError(invalidCode, `${service} apiKey resolved to an empty or non-string value`)
  }
  return resolved
}

export function buildSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
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

    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason as Error)
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function parseErrorBody(response: Response): Promise<{ type: string; message: string }> {
  const fallback = `HTTP ${response.status}`
  try {
    const body = (await response.json()) as ServiceErrorBody | null
    const nested =
      typeof body?.error === 'object' && body.error !== null ? (body.error as Record<string, unknown>) : null
    const errorType = textOf(nested?.type) ?? 'unknown'
    const errorMessage =
      textOf(nested?.message) ?? textOf(body?.error) ?? textOf(body?.message) ?? textOf(body?.detail) ?? fallback
    return { type: errorType, message: errorMessage }
  } catch {
    return { type: 'unknown', message: fallback }
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')
}

export async function postJsonWithRetry(request: RetryingPost): Promise<Record<string, unknown>> {
  const { url, body, apiKey, maxRetries, signal, service, failureCode } = request
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey !== null) headers.Authorization = `Bearer ${apiKey}`
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url, { method: 'POST', headers, body, signal })
    } catch (err: unknown) {
      if (isAbort(err)) throw err
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxRetries) {
        await sleep(computeBackoffMs(attempt, null), signal)
        continue
      }
      throw new NarsilError(failureCode, `${service} request failed after ${maxRetries + 1} attempts: network error`, {
        cause: lastError.message,
      })
    }

    if (response.ok) {
      let parsed: unknown
      try {
        parsed = await response.json()
      } catch {
        lastError = new Error('invalid JSON in a 2xx response body')
        if (attempt < maxRetries) {
          await sleep(computeBackoffMs(attempt, null), signal)
          continue
        }
        throw new NarsilError(failureCode, `${service} returned invalid JSON in response body`)
      }
      if (parsed === null || typeof parsed !== 'object') {
        throw new NarsilError(failureCode, `${service} returned non-object JSON response`)
      }
      return parsed as Record<string, unknown>
    }

    const retryAfter = parseRetryAfterHeader(response.headers)
    const errorInfo = await parseErrorBody(response)

    if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= maxRetries) {
      throw new NarsilError(
        failureCode,
        `${service} API error (${response.status}): [${errorInfo.type}] ${errorInfo.message}`,
        { status: response.status, errorType: errorInfo.type },
      )
    }

    lastError = new Error(`HTTP ${response.status}: ${errorInfo.type}`)
    await sleep(computeBackoffMs(attempt, retryAfter), signal)
  }

  throw new NarsilError(failureCode, `${service} request failed: exhausted all retries`, {
    cause: lastError?.message,
  })
}
