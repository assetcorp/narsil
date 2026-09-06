import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import type { RequestGate } from './concurrency-gate'
import { ServerErrorCodes } from './errors'
import { type ResponseSink, sendError } from './response'
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
export function initAbortHandler(res: ResponseSink): ResponseAbort {
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
export function readBody(res: ResponseSink, maxBytes: number, abort: ResponseAbort): Promise<Buffer> {
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
      chunks.push(Buffer.from(new Uint8Array(chunk)))
      if (isLast) {
        done = true
        resolve(Buffer.concat(chunks))
      }
    })
  })
}

export interface RouteContext {
  res: ResponseSink
  params: string[]
  query: URLSearchParams
  contentType: string
  rawBody: Buffer | null
  abort: ResponseAbort
  /** The request's method, path, headers, and peer address, captured where an admission hook runs. */
  hookContext: RequestContext | null
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

function decodePathParameter(raw: string): string | null {
  if (!raw.includes('%')) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/**
 * Decides whether a request may proceed, from its captured context.
 *
 * @internal
 */
export type Authorizer = (context: RequestContext) => Promise<Authorization>

export type Authorization = { allowed: true } | { allowed: false; denial: RequestDenial | null }

export interface RunnerDeps {
  authorize?: Authorizer
  gate: RequestGate
  writeCors?: (res: HttpResponse, req: HttpRequest) => void
}

function isDenial(value: unknown): value is RequestDenial {
  return typeof value === 'object' && value !== null && 'status' in value
}

/**
 * Turns the server's admission hook into an authoriser, catching whatever
 * the hook throws so that a broken hook denies the request and the server
 * answers with a hook error.
 *
 * @param hook The hook the server was created with.
 * @returns The authoriser the route runner consults per request.
 *
 * @internal
 */
export function authorizerFor(hook: OnRequestHook): Authorizer {
  return async context => {
    try {
      const result = await hook(context)
      if (isDenial(result)) return { allowed: false, denial: result }
      return { allowed: true }
    } catch {
      return { allowed: false, denial: null }
    }
  }
}

function sendDenial(res: ResponseSink, authorization: Authorization): void {
  if (authorization.allowed) return
  if (authorization.denial === null) {
    sendError(res, 500, ServerErrorCodes.HOOK_ERROR, 'The onRequest hook threw an error')
    return
  }
  sendError(res, authorization.denial.status, authorization.denial.code, authorization.denial.message)
}

/**
 * Builds the per-route adapter from a uWebSockets.js callback to a
 * {@link RouteHandler}. It captures request fields synchronously (required by
 * uWebSockets.js), runs the optional auth hook in parallel with the body read,
 * sheds load past the concurrency cap, and turns any thrown value into a 500.
 */
export function createRouteRunner(deps: RunnerDeps) {
  const { authorize, gate, writeCors } = deps

  return (handler: RouteHandler, opts: RouteOptions) => {
    const paramCount = opts.paramCount ?? 0
    const needsBody = opts.needsBody ?? false
    const useHook = authorize !== undefined && !opts.skipHooks
    const gated = !opts.skipHooks

    return (res: HttpResponse, req: HttpRequest): void => {
      const params: string[] = []
      let malformed: string | null = null
      for (let i = 0; i < paramCount; i++) {
        const decoded = decodePathParameter(req.getParameter(i) ?? '')
        if (decoded === null) {
          malformed = req.getParameter(i) ?? ''
          break
        }
        params.push(decoded)
      }
      const query = new URLSearchParams(req.getQuery() ?? '')
      const contentType = req.getHeader('content-type')

      let hookContext: RequestContext | null = null
      if (useHook) {
        const headers: Record<string, string> = {}
        req.forEach((key, value) => {
          headers[key] = value
        })
        hookContext = {
          method: req.getMethod(),
          path: req.getUrl(),
          headers,
          remoteAddress: Buffer.from(res.getRemoteAddressAsText()).toString(),
        }
      }

      if (writeCors) writeCors(res, req)

      const abort = initAbortHandler(res)
      if (malformed !== null) {
        sendError(
          res,
          400,
          ServerErrorCodes.INVALID_REQUEST,
          'A path segment holds a percent-escape the server cannot decode',
          { segment: malformed },
        )
        return
      }
      const bodyPromise = needsBody ? readBody(res, opts.maxBytes, abort) : Promise.resolve<Buffer | null>(null)
      const hookPromise: Promise<Authorization> =
        hookContext !== null && authorize !== undefined ? authorize(hookContext) : Promise.resolve({ allowed: true })

      Promise.all([bodyPromise, hookPromise])
        .then(async ([rawBody, authorization]) => {
          if (abort.aborted) return
          if (!authorization.allowed) {
            sendDenial(res, authorization)
            return
          }
          if (gated && !gate.tryAcquire()) {
            sendError(res, 429, ServerErrorCodes.TOO_MANY_REQUESTS, 'The server is at capacity; retry shortly')
            return
          }
          try {
            await handler({ res, params, query, contentType, rawBody, abort, hookContext })
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
