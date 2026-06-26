import { NarsilError } from '../../errors'
import type { AnyDocument } from '../../types/schema'
import type { HandlerDeps } from '../deps'
import { ServerErrorCodes, serializeNarsilError } from '../errors'
import { respondError, respondJson } from '../handler-utils'
import { iterateNdjson, NdjsonLineTooLongError } from '../ndjson'
import type { RouteContext } from '../request'
import { sendError } from '../response'

interface ImportError {
  line?: number
  docId?: string
  code: string
  message: string
}

interface PendingDoc {
  document: AnyDocument
  line: number
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Streams an NDJSON corpus into the engine in bounded batches, yielding the
 * event loop between batches so searches and health probes stay responsive on
 * the single thread. Per-line parse failures and per-document engine failures
 * are collected and returned together, so one bad record never aborts the load.
 */
export function createImportHandler(deps: HandlerDeps) {
  const { engine, limits } = deps

  return async function importNdjson(ctx: RouteContext): Promise<void> {
    const raw = ctx.rawBody
    if (!raw || raw.length === 0) {
      sendError(ctx.res, 400, ServerErrorCodes.EMPTY_BODY, 'Request body is empty')
      return
    }

    const name = ctx.params[0]
    const errors: ImportError[] = []
    let indexed = 0
    let pending: PendingDoc[] = []

    const flush = async (): Promise<boolean> => {
      if (pending.length === 0) return true
      const documents = pending.map(p => p.document)
      try {
        const result = await engine.insertBatch(name, documents)
        indexed += result.succeeded.length
        for (const failure of result.failed) {
          const serialized =
            failure.error instanceof NarsilError
              ? serializeNarsilError(failure.error)
              : { code: 'INTERNAL_ERROR', message: String(failure.error) }
          errors.push({ docId: failure.docId, code: serialized.code, message: serialized.message })
        }
        pending = []
        return true
      } catch (err) {
        respondError(ctx, err)
        return false
      }
    }

    try {
      for (const { lineNumber, text } of iterateNdjson(raw, limits.maxLineBytes)) {
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          errors.push({ line: lineNumber, code: ServerErrorCodes.INVALID_JSON, message: 'Line is not valid JSON' })
          continue
        }
        if (!isPlainObject(parsed)) {
          errors.push({
            line: lineNumber,
            code: ServerErrorCodes.INVALID_REQUEST,
            message: 'Line is not a JSON object',
          })
          continue
        }
        pending.push({ document: parsed, line: lineNumber })
        if (pending.length >= limits.importBatchSize) {
          if (!(await flush())) return
          if (ctx.abort.aborted) return
          await yieldToEventLoop()
          if (ctx.abort.aborted) return
        }
      }
    } catch (err) {
      if (err instanceof NdjsonLineTooLongError) {
        sendError(ctx.res, 413, ServerErrorCodes.PAYLOAD_TOO_LARGE, err.message, { line: err.lineNumber })
        return
      }
      respondError(ctx, err)
      return
    }

    if (!(await flush())) return
    if (ctx.abort.aborted) return
    respondJson(ctx, { indexed, failed: errors.length, errors })
  }
}
