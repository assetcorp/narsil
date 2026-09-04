import { ClientErrorCodes, describeError, ErrorCodes, NarsilError } from '../errors'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './constants'
import type { FetchFunction, NarsilClientOptions, RequestOptions } from './options'

/** This describes one exchange, which a client method fills in and the
 * transport turns into a request. */
export interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query?: Record<string, string | undefined>
  body?: string | Uint8Array
  contentType?: string
  /** Setting this reads a successful answer as bytes, which the snapshot
   * download needs. A failure still answers with a JSON error envelope. */
  binaryAnswer?: boolean
  defaultTimeoutMs?: number
  options?: RequestOptions
}

/** This sends the request every client method builds, and it turns each
 * failure into a {@link NarsilError} under the code the server sent. */
export interface Transport {
  json<T>(spec: RequestSpec): Promise<T>
  jsonOrNull<T>(spec: RequestSpec, absentCode: string): Promise<T | null>
  binary(spec: RequestSpec): Promise<Uint8Array>
  probe(spec: RequestSpec): Promise<number>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const unrefable = timer as unknown as { unref?: () => void }
  unrefable.unref?.()
}

function startDeadline(timeoutMs: number, caller: AbortSignal | undefined) {
  const controller = new AbortController()
  let expired = false
  const abortWithCaller = (): void => controller.abort()
  if (caller?.aborted) controller.abort()
  else caller?.addEventListener('abort', abortWithCaller)

  let timer: ReturnType<typeof setTimeout> | undefined
  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, timeoutMs)
    unrefTimer(timer)
  }

  return {
    signal: controller.signal,
    expired: (): boolean => expired,
    release: (): void => {
      if (timer !== undefined) clearTimeout(timer)
      caller?.removeEventListener('abort', abortWithCaller)
    },
  }
}

class ResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`The answer passed the ${limitBytes} byte ceiling this client reads`)
  }
}

async function readStreamCapped(stream: ReadableStream<Uint8Array>, limitBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limitBytes) throw new ResponseTooLargeError(limitBytes)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
    if (total > limitBytes) await stream.cancel().catch(() => undefined)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function readAnswer(
  response: Response,
  limitBytes: number,
  wantsBytes: boolean,
): Promise<{ text: string; bytes: Uint8Array | null }> {
  const stream: ReadableStream<Uint8Array> | null | undefined = response.body
  if (limitBytes > 0 && stream !== null && stream !== undefined) {
    const body = await readStreamCapped(stream, limitBytes)
    return wantsBytes ? { text: '', bytes: body } : { text: new TextDecoder().decode(body), bytes: null }
  }

  if (wantsBytes) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (limitBytes > 0 && bytes.byteLength > limitBytes) throw new ResponseTooLargeError(limitBytes)
    return { text: '', bytes }
  }

  const text = await response.text()
  if (limitBytes > 0 && text.length > limitBytes) throw new ResponseTooLargeError(limitBytes)
  return { text, bytes: null }
}

function invalidResponse(message: string, details: Record<string, unknown>): NarsilError {
  return new NarsilError(ClientErrorCodes.CLIENT_INVALID_RESPONSE, message, details)
}

function errorFromBody(status: number, payload: unknown, url: string): NarsilError {
  const envelope = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined
  if (envelope === undefined || typeof envelope.code !== 'string' || typeof envelope.message !== 'string') {
    return invalidResponse(`The server answered HTTP ${status} without a Narsil error envelope`, { url, status })
  }
  const details = isRecord(envelope.details) ? envelope.details : {}
  return new NarsilError(envelope.code, envelope.message, { ...details, status })
}

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function normaliseBase(url: string): string {
  const trimmed = url.trim()
  if (trimmed.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The client needs a server address, and "url" is empty')
  }
  if (!trimmed.startsWith('/') && !isAbsoluteUrl(trimmed)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `The client cannot read "${trimmed}" as a server address; pass an absolute URL or a path starting with "/"`,
      { url: trimmed },
    )
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function withQuery(path: string, query: RequestSpec['query']): string {
  if (query === undefined) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value)
  }
  const encoded = params.toString()
  return encoded.length === 0 ? path : `${path}?${encoded}`
}

/**
 * Builds the transport every client method shares. It resolves the address, the
 * credentials, and the deadline before it sends a request, and it translates
 * whatever comes back.
 *
 * @param options - These are the address, the credentials, and the defaults the
 * client was built with.
 * @returns This is the transport each group of operations sends through.
 */
export function createTransport(options: NarsilClientOptions): Transport {
  const base = normaliseBase(options.url)
  const send: FetchFunction = options.fetch ?? ((input, init) => fetch(input, init))
  const baseHeaders: Record<string, string> = { ...options.headers }
  if (options.apiKey !== undefined && options.apiKey.length > 0) {
    baseHeaders.authorization = `Bearer ${options.apiKey}`
  }

  function resolveTimeout(spec: RequestSpec): number {
    const perCall = spec.options?.timeoutMs
    if (perCall !== undefined) return perCall
    if (options.timeoutMs !== undefined) return options.timeoutMs
    return spec.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  function resolveResponseCeiling(spec: RequestSpec): number {
    const perCall = spec.options?.maxResponseBytes
    if (perCall !== undefined) return perCall
    return options.maxResponseBytes ?? 0
  }

  async function exchange(spec: RequestSpec): Promise<{ status: number; text: string; bytes: Uint8Array | null }> {
    const url = `${base}${withQuery(spec.path, spec.query)}`
    const headers: Record<string, string> = { ...baseHeaders, ...spec.options?.headers }
    if (spec.contentType !== undefined) headers['content-type'] = spec.contentType
    const timeoutMs = resolveTimeout(spec)
    const deadline = startDeadline(timeoutMs, spec.options?.signal)

    try {
      const init: RequestInit = { method: spec.method, headers, signal: deadline.signal }
      if (spec.body !== undefined) init.body = spec.body as BodyInit
      const response = await send(url, init)
      const wantsBytes = spec.binaryAnswer === true && response.ok
      const answer = await readAnswer(response, resolveResponseCeiling(spec), wantsBytes)
      return { status: response.status, ...answer }
    } catch (err) {
      if (err instanceof ResponseTooLargeError) {
        throw invalidResponse(`The server at ${url} answered more than this client reads: ${err.message}`, {
          url,
          maxResponseBytes: err.limitBytes,
        })
      }
      if (deadline.expired()) {
        throw new NarsilError(
          ClientErrorCodes.CLIENT_REQUEST_TIMEOUT,
          `The server at ${url} did not answer within ${timeoutMs} ms`,
          { url, timeoutMs },
        )
      }
      if (spec.options?.signal?.aborted === true) {
        throw new NarsilError(ClientErrorCodes.CLIENT_REQUEST_ABORTED, `The caller cancelled the request to ${url}`, {
          url,
        })
      }
      throw new NarsilError(
        ClientErrorCodes.CLIENT_CONNECTION_FAILED,
        `The client could not reach ${url}: ${describeError(err)}`,
        { url },
      )
    } finally {
      deadline.release()
    }
  }

  function parse(status: number, text: string, path: string): unknown {
    if (text.length === 0) return undefined
    try {
      return JSON.parse(text)
    } catch {
      throw invalidResponse(`The server answered HTTP ${status} with a body that is not JSON`, { url: path, status })
    }
  }

  async function json<T>(spec: RequestSpec): Promise<T> {
    const { status, text } = await exchange(spec)
    const payload = parse(status, text, spec.path)
    if (status >= 200 && status < 300) return payload as T
    throw errorFromBody(status, payload, spec.path)
  }

  return {
    json,
    async jsonOrNull<T>(spec: RequestSpec, absentCode: string): Promise<T | null> {
      try {
        return await json<T>(spec)
      } catch (err) {
        if (err instanceof NarsilError && err.code === absentCode) return null
        throw err
      }
    },
    async binary(spec: RequestSpec): Promise<Uint8Array> {
      const { status, text, bytes } = await exchange(spec)
      if (bytes !== null) return bytes
      throw errorFromBody(status, parse(status, text, spec.path), spec.path)
    },
    async probe(spec: RequestSpec): Promise<number> {
      const { status } = await exchange(spec)
      return status
    },
  }
}
