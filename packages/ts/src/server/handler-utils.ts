import { NarsilError } from '../errors'
import type { WriteBlockLookup } from '../narsil/write-blocks'
import type { BatchResult } from '../types/results'
import { ServerErrorCodes, serializeNarsilError, toHttpError } from './errors'
import { type ParsedBodyKind, parseRefusalOf } from './parse-heap'
import type { RouteContext } from './request'
import { type ResponseSink, sendError, sendJson } from './response'
import type { ValidationFailure } from './validation'

function refusesParse(ctx: RouteContext, raw: Buffer | null, kind: ParsedBodyKind): boolean {
  const refusal = ctx.bodyRefusal ?? (raw === null ? null : parseRefusalOf(raw, kind))
  if (refusal === null) return false
  if (!ctx.abort.aborted) sendError(ctx.res, refusal.status, refusal.code, refusal.message, refusal.details)
  return true
}

/** Parses a required JSON body. Sends 400 and returns undefined when the body is
 * empty or malformed, so a handler can `if (!body) return`. The server answers
 * 429 where parsing the body can take the heap past its limit, and 413 where
 * parsing it can pass that limit even on an idle heap. */
export function parseJson<T>(ctx: RouteContext, kind: ParsedBodyKind = 'write'): T | undefined {
  const raw = ctx.rawBody
  if (refusesParse(ctx, raw, kind)) return undefined
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

export async function parseWriteJson<T>(
  ctx: RouteContext,
  writeBlock: WriteBlockLookup | undefined,
): Promise<T | undefined> {
  const raw = ctx.rawBody
  if (writeBlock === undefined || (ctx.bodyRefusal === null && (!raw || raw.length === 0))) return parseJson<T>(ctx)
  const refusal = ctx.bodyRefusal ?? (raw === null ? null : parseRefusalOf(raw))
  if (refusal === null) {
    try {
      return JSON.parse(raw?.toString('utf8') ?? '') as T
    } catch {
      sendError(ctx.res, 400, ServerErrorCodes.INVALID_JSON, 'Request body is not valid JSON')
      return undefined
    }
  }
  const block = refusal.status === 429 ? await writeBlock(ctx.params[0]).catch(() => null) : null
  if (block !== null) respondError(ctx, block)
  else if (!ctx.abort.aborted) sendError(ctx.res, refusal.status, refusal.code, refusal.message, refusal.details)
  return undefined
}

/** Parses an optional JSON body, treating an empty body as an empty object. */
export function parseJsonOptional<T extends object>(ctx: RouteContext): T | undefined {
  const raw = ctx.rawBody
  if (refusesParse(ctx, raw, 'write')) return undefined
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

export function badRequest(res: ResponseSink, message: string, details?: Record<string, unknown>): void {
  sendError(res, 400, ServerErrorCodes.INVALID_REQUEST, message, details)
}

/** Sends a 400 for a failed request-shape check, unless the client already
 * disconnected. */
export function rejectInvalid(ctx: RouteContext, failure: ValidationFailure): void {
  if (ctx.abort.aborted) return
  badRequest(ctx.res, failure.message, failure.details)
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
