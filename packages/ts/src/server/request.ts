import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import { ServerErrorCodes } from './errors'
import { sendError } from './response'
import type { OnRequestHook, RequestContext, RequestDenial } from './types'

export interface ResponseAbort {
  readonly aborted: boolean
  onAbort(fn: () => void): void
}

/**
 * Registers the uWebSockets.js abort callback. This MUST run synchronously at
 * the top of a handler: once the handler awaits, `res` is only safe to touch if
 * `onAborted` was already attached, otherwise uWebSockets.js throws on write.
 */
export function initAbortHandler(res: HttpResponse): ResponseAbort {
  const listeners: Array<() => void> = []
  let aborted = false
  res.onAborted(() => {
    aborted = true
    for (const fn of listeners) fn()
  })
  return {
    get aborted() {
      return aborted
    },
    onAbort(fn) {
      if (aborted) fn()
      else listeners.push(fn)
    },
  }
}

/** Buffers the request body, enforcing a byte ceiling. Exceeding the cap sends
 * 413 and rejects, so a single oversized body cannot grow unbounded in memory. */
export function readBody(res: HttpResponse, maxBytes: number, abort: ResponseAbort): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (abort.aborted) {
      reject(new Error('aborted'))
      return
    }
    let done = false
    let total = 0
    const chunks: Buffer[] = []
    abort.onAbort(() => {
      if (done) return
      done = true
      reject(new Error('aborted'))
    })
    res.onData((chunk, isLast) => {
      if (done || abort.aborted) return
      total += chunk.byteLength
      if (total > maxBytes) {
        done = true
        if (!abort.aborted) {
          sendError(res, 413, ServerErrorCodes.PAYLOAD_TOO_LARGE, 'Request body exceeds the configured size limit')
        }
        reject(new Error('payload too large'))
        return
      }
      chunks.push(Buffer.from(chunk))
      if (isLast) {
        done = true
        resolve(Buffer.concat(chunks))
      }
    })
  })
}

export interface RouteContext {
  res: HttpResponse
  params: string[]
  query: URLSearchParams
  contentType: string
  rawBody: Buffer | null
  abort: ResponseAbort
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void

export interface RouteOptions {
  paramCount?: number
  needsBody?: boolean
  maxBytes: number
  /** Skips the auth hook and the concurrency gate. Used for liveness and
   * readiness probes, which must answer regardless of auth or load. */
  skipHooks?: boolean
}

class ConcurrencyGate {
  private inFlight = 0
  constructor(private readonly max: number) {}
  tryAcquire(): boolean {
    if (this.max <= 0) return true
    if (this.inFlight >= this.max) return false
    this.inFlight++
    return true
  }
  release(): void {
    if (this.max <= 0) return
    if (this.inFlight > 0) this.inFlight--
  }
}

export interface RunnerDeps {
  onRequest?: OnRequestHook
  maxConcurrentRequests: number
  writeCors?: (res: HttpResponse, req: HttpRequest) => void
}

function isDenial(value: unknown): value is RequestDenial {
  return typeof value === 'object' && value !== null && 'status' in value
}

async function runHook(res: HttpResponse, ctx: RequestContext, hook: OnRequestHook): Promise<boolean> {
  try {
    const result = await hook(ctx)
    if (isDenial(result)) {
      sendError(res, result.status, result.code, result.message)
      return false
    }
    return true
  } catch {
    sendError(res, 500, ServerErrorCodes.HOOK_ERROR, 'The onRequest hook threw an error')
    return false
  }
}

/**
 * Builds the per-route adapter from a uWebSockets.js callback to a
 * {@link RouteHandler}. It captures request fields synchronously (required by
 * uWebSockets.js), runs the optional auth hook in parallel with the body read,
 * sheds load past the concurrency cap, and turns any thrown value into a 500.
 */
export function createRouteRunner(deps: RunnerDeps) {
  const gate = new ConcurrencyGate(deps.maxConcurrentRequests)
  const { onRequest, writeCors } = deps

  return (handler: RouteHandler, opts: RouteOptions) => {
    const paramCount = opts.paramCount ?? 0
    const needsBody = opts.needsBody ?? false
    const useHook = Boolean(onRequest) && !opts.skipHooks
    const gated = !opts.skipHooks

    return (res: HttpResponse, req: HttpRequest): void => {
      const params: string[] = []
      for (let i = 0; i < paramCount; i++) params.push(req.getParameter(i) ?? '')
      const query = new URLSearchParams(req.getQuery() ?? '')
      const contentType = req.getHeader('content-type')

      let hookCtx: RequestContext | null = null
      if (useHook) {
        const headers: Record<string, string> = {}
        req.forEach((key, value) => {
          headers[key] = value
        })
        hookCtx = {
          method: req.getMethod(),
          path: req.getUrl(),
          headers,
          remoteAddress: Buffer.from(res.getRemoteAddressAsText()).toString(),
        }
      }

      if (writeCors) writeCors(res, req)

      const abort = initAbortHandler(res)
      const bodyPromise = needsBody ? readBody(res, opts.maxBytes, abort) : Promise.resolve<Buffer | null>(null)
      const hookPromise = hookCtx && onRequest ? runHook(res, hookCtx, onRequest) : Promise.resolve(true)

      Promise.all([bodyPromise, hookPromise])
        .then(async ([rawBody, allowed]) => {
          if (abort.aborted || !allowed) return
          if (gated && !gate.tryAcquire()) {
            sendError(res, 503, ServerErrorCodes.TOO_MANY_REQUESTS, 'The server is at capacity; retry shortly')
            return
          }
          try {
            await handler({ res, params, query, contentType, rawBody, abort })
          } catch (err) {
            if (!abort.aborted) {
              sendError(res, 500, ServerErrorCodes.INTERNAL_ERROR, 'An unexpected error occurred')
            }
            void err
          } finally {
            if (gated) gate.release()
          }
        })
        .catch(() => {})
    }
  }
}
