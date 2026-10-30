import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import type { BodyBudget } from './body-budget'
import type { RequestGate } from './concurrency-gate'
import { ServerErrorCodes } from './errors'
import type { ParseRefusal } from './parse-heap'
import { type BodyKindOf, RefusedBody, readBody } from './read-body'
import { type ResponseSink, sendError } from './response'
import { type SpooledBody, spoolBody } from './spool'
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

function declaredBodyBytes(header: string): number | null {
  return /^\d{1,15}$/.test(header) ? Number(header) : null
}

export interface RouteContext {
  res: ResponseSink
  params: string[]
  query: URLSearchParams
  contentType: string
  rawBody: Buffer | null
  /** The memory check refused the body before the server read all of it, so the handler answers with this. */
  bodyRefusal: ParseRefusal | null
  spooledBody: SpooledBody | null
  abort: ResponseAbort
  /** The request's method, path, headers, and peer address, captured where an admission hook runs. */
  hookContext: RequestContext | null
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void

export interface RouteOptions {
  paramCount?: number
  needsBody?: boolean
  spoolsBody?: boolean
  /** Tells the memory check which line a body parses against, from its first bytes, or null until they show it. */
  bodyKind?: BodyKindOf
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

export type Authorizer = (context: RequestContext) => Promise<Authorization>

export type Authorization = { allowed: true } | { allowed: false; denial: RequestDenial | null }

export interface RunnerDeps {
  authorize?: Authorizer
  gate: RequestGate
  bodyBudget: BodyBudget
  corsHeaders?: (req: HttpRequest) => Array<[string, string]>
  track?: (res: ResponseSink, abort: ResponseAbort) => () => void
}

export function sinkWritingAfterStatus(res: ResponseSink, headers: Array<[string, string]>): ResponseSink {
  if (headers.length === 0) return res
  const sink: ResponseSink = {
    cork(callback) {
      res.cork(callback)
      return sink
    },
    writeStatus(status) {
      res.writeStatus(status)
      for (const [key, value] of headers) res.writeHeader(key, value)
      return sink
    },
    writeHeader(key, value) {
      res.writeHeader(key, value)
      return sink
    },
    end(body, closeConnection) {
      res.end(body, closeConnection)
      return sink
    },
    write(chunk) {
      return res.write(chunk)
    },
    pause() {
      res.pause()
    },
    resume() {
      res.resume()
    },
    close() {
      res.close()
      return sink
    },
    endWithoutBody() {
      res.endWithoutBody()
      return sink
    },
    tryEnd(body, totalSize) {
      return res.tryEnd(body, totalSize)
    },
    getWriteOffset() {
      return res.getWriteOffset()
    },
    onWritable(handler) {
      res.onWritable(handler)
      return sink
    },
    onAborted(handler) {
      res.onAborted(handler)
      return sink
    },
    onData(handler) {
      res.onData(handler)
      return sink
    },
    getRemoteAddressAsText() {
      return res.getRemoteAddressAsText()
    },
  }
  return sink
}

function isDenial(value: unknown): value is RequestDenial {
  return typeof value === 'object' && value !== null && 'status' in value
}

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
  const { authorize, gate, bodyBudget, corsHeaders, track } = deps

  return (handler: RouteHandler, opts: RouteOptions) => {
    const paramCount = opts.paramCount ?? 0
    const needsBody = opts.needsBody ?? false
    const useHook = authorize !== undefined && !opts.skipHooks
    const gated = !opts.skipHooks

    return (response: HttpResponse, req: HttpRequest): void => {
      const res = corsHeaders ? sinkWritingAfterStatus(response, corsHeaders(req)) : response
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
      const declaredBytes = needsBody ? declaredBodyBytes(req.getHeader('content-length')) : null

      let hookContext: RequestContext | null = null
      if (useHook) {
        const headers: Record<string, string> = {}
        req.forEach((key, value) => {
          headers[key] = value
        })
        hookContext = {
          method: req.getMethod().toUpperCase(),
          path: req.getUrl(),
          headers,
          remoteAddress: Buffer.from(res.getRemoteAddressAsText()).toString(),
        }
      }

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
      const release = track?.(res, abort)
      const bodyHold = bodyBudget.hold()
      let bodyRefusal: ParseRefusal | null = null
      const bodyPromise = needsBody
        ? readBody(res, opts.maxBytes, abort, bodyHold, declaredBytes, opts.bodyKind ?? null).catch((err: unknown) => {
            if (!(err instanceof RefusedBody)) throw err
            bodyRefusal = err.refusal
            return null
          })
        : Promise.resolve<Buffer | null>(null)
      const hookPromise: Promise<Authorization> =
        hookContext !== null && authorize !== undefined ? authorize(hookContext) : Promise.resolve({ allowed: true })
      const spoolPromise =
        opts.spoolsBody === true
          ? spoolBody(
              res,
              opts.maxBytes,
              abort,
              hookPromise.then(authorization => authorization.allowed),
            ).catch(() => null)
          : Promise.resolve<SpooledBody | null>(null)

      const running = Promise.all([bodyPromise, spoolPromise, hookPromise])
        .then(async ([rawBody, spooledBody, authorization]) => {
          const discardSpool = (): void => {
            void spooledBody?.remove().catch(() => undefined)
          }
          if (abort.aborted) {
            discardSpool()
            return
          }
          if (!authorization.allowed) {
            discardSpool()
            sendDenial(res, authorization)
            return
          }
          if (opts.spoolsBody === true && spooledBody === null) return
          if (gated && !gate.tryAcquire()) {
            discardSpool()
            sendError(res, 429, ServerErrorCodes.TOO_MANY_REQUESTS, 'The server is at capacity; retry shortly')
            return
          }
          try {
            await handler({ res, params, query, contentType, rawBody, bodyRefusal, spooledBody, abort, hookContext })
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
        .finally(() => bodyHold.releaseAll())
      if (release !== undefined) void running.then(release)
    }
  }
}
