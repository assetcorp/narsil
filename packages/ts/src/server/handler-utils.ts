import type { HttpResponse } from 'uWebSockets.js'
import { NarsilError } from '../errors'
import type { BatchResult } from '../types/results'
import { ServerErrorCodes, serializeNarsilError, toHttpError } from './errors'
import type { RouteContext } from './request'
import { sendError, sendJson } from './response'

/** Parses a required JSON body. Sends 400 and returns undefined when the body is
 * empty or malformed, so a handler can `if (!body) return`. */
export function parseJson<T>(ctx: RouteContext): T | undefined {
  const raw = ctx.rawBody
  if (!raw || raw.length === 0) {
    sendError(ctx.res, 400, ServerErrorCodes.EMPTY_BODY, 'Request body is empty')
    return undefined
  }
  try {
    return JSON.parse(raw.toString('utf8')) as T
  } catch {
    sendError(ctx.res, 400, ServerErrorCodes.INVALID_JSON, 'Request body is not valid JSON')
    return undefined
  }
}

/** Parses an optional JSON body, treating an empty body as an empty object. */
export function parseJsonOptional<T extends object>(ctx: RouteContext): T | undefined {
  const raw = ctx.rawBody
  if (!raw || raw.length === 0) return {} as T
  try {
    return JSON.parse(raw.toString('utf8')) as T
  } catch {
    sendError(ctx.res, 400, ServerErrorCodes.INVALID_JSON, 'Request body is not valid JSON')
    return undefined
  }
}

/** Writes the mapped HTTP status and safe envelope for any thrown value, unless
 * the client already disconnected. */
export function respondError(ctx: RouteContext, err: unknown): void {
  if (ctx.abort.aborted) return
  const { status, body } = toHttpError(err)
  sendError(ctx.res, status, body.code, body.message, body.details)
}

export function respondJson(ctx: RouteContext, data: unknown, status = 200): void {
  if (ctx.abort.aborted) return
  sendJson(ctx.res, data, status, ctx.abort)
}

export function badRequest(res: HttpResponse, message: string, details?: Record<string, unknown>): void {
  sendError(res, 400, ServerErrorCodes.INVALID_REQUEST, message, details)
}

export interface SerializedBatchResult {
  succeeded: string[]
  failed: Array<{ docId: string; error: { code: string; message: string; details?: Record<string, unknown> } }>
}

export function serializeBatchResult(result: BatchResult): SerializedBatchResult {
  return {
    succeeded: result.succeeded,
    failed: result.failed.map(f => ({
      docId: f.docId,
      error:
        f.error instanceof NarsilError
          ? serializeNarsilError(f.error)
          : { code: 'INTERNAL_ERROR', message: String(f.error) },
    })),
  }
}
