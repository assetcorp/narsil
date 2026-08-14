import { NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { AnyDocument } from '../../types/schema'
import type { HandlerDeps } from '../deps'
import { ServerErrorCodes, serializeNarsilError } from '../errors'
import { respondError, respondJson } from '../handler-utils'
import { iterateNdjson, NdjsonLineTooLongError } from '../ndjson'
import type { RouteContext } from '../request'
import { sendError } from '../response'
import type { ImportError, ImportResult, TaskProgress } from '../types'

interface PendingDoc {
  document: AnyDocument
  line: number
}

export interface ImportRunOptions {
  indexName: string
  body: Buffer
  maxLineBytes: number
  batchSize: number
  maxErrors: number
  signal?: AbortSignal
  onProgress?: (progress: TaskProgress) => void
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
 * are collected and returned together, so one bad record never aborts the load,
 * and the collected list stops at `maxErrors` while the reported total keeps
 * counting.
 *
 * @param engine - The engine the documents are written into.
 * @param options - The index, the buffered body, the batching and reporting
 * ceilings, an optional signal that stops the load between batches, and an
 * optional progress callback.
 * @returns How many documents the engine accepted and refused, with the first
 * refusals and whether that list was cut short.
 */
export async function runImport(engine: Narsil, options: ImportRunOptions): Promise<ImportResult> {
  const { indexName, body, maxLineBytes, batchSize, maxErrors, signal, onProgress } = options
  const bytesTotal = body.length
  const errors: ImportError[] = []
  let indexed = 0
  let failed = 0
  let bytesProcessed = 0
  let pending: PendingDoc[] = []

  const recordFailure = (error: ImportError): void => {
    failed += 1
    if (errors.length < maxErrors) errors.push(error)
  }

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return
    const documents = pending.map(entry => entry.document)
    pending = []
    const result = await engine.insertBatch(indexName, documents)
    indexed += result.succeeded.length
    for (const failure of result.failed) {
      const serialized =
        failure.error instanceof NarsilError
          ? serializeNarsilError(failure.error)
          : { code: ServerErrorCodes.INTERNAL_ERROR, message: String(failure.error) }
      recordFailure({ docId: failure.docId, code: serialized.code, message: serialized.message })
    }
  }

  const report = (): void => {
    onProgress?.({ indexed, failed, bytesProcessed, bytesTotal })
  }

  for (const line of iterateNdjson(body, maxLineBytes)) {
    bytesProcessed = line.bytesConsumed
    let parsed: unknown
    try {
      parsed = JSON.parse(line.text)
    } catch {
      recordFailure({ line: line.lineNumber, code: ServerErrorCodes.INVALID_JSON, message: 'Line is not valid JSON' })
      continue
    }
    if (!isPlainObject(parsed)) {
      recordFailure({
        line: line.lineNumber,
        code: ServerErrorCodes.INVALID_REQUEST,
        message: 'Line is not a JSON object',
      })
      continue
    }
    pending.push({ document: parsed, line: line.lineNumber })
    if (pending.length >= batchSize) {
      signal?.throwIfAborted()
      await flush()
      report()
      await yieldToEventLoop()
      signal?.throwIfAborted()
    }
  }

  await flush()
  bytesProcessed = bytesTotal
  report()
  return { indexed, failed, errors, errorsTruncated: failed > errors.length }
}

/**
 * Serves `POST /indexes/{name}/documents/_import`. The load runs inside the
 * request by default. Asking for `?async=true` starts a task instead and
 * answers 202 with its record, so a corpus larger than a request timeout can be
 * followed through `GET /tasks/{id}` and stopped through
 * `POST /tasks/{id}/_cancel`.
 */
export function createImportHandler(deps: HandlerDeps) {
  const { engine, limits, tasks } = deps

  return async function importNdjson(ctx: RouteContext): Promise<void> {
    const raw = ctx.rawBody
    if (!raw || raw.length === 0) {
      sendError(ctx.res, 400, ServerErrorCodes.EMPTY_BODY, 'Request body is empty')
      return
    }

    const indexName = ctx.params[0]
    const runOptions = {
      indexName,
      body: raw,
      maxLineBytes: limits.maxLineBytes,
      batchSize: limits.importBatchSize,
      maxErrors: limits.maxImportErrors,
    }

    if (ctx.query.get('async') === 'true') {
      try {
        engine.getStats(indexName)
      } catch (err) {
        respondError(ctx, err)
        return
      }
      const record = await tasks.start(
        'import',
        indexName,
        async context => {
          const result = await runImport(engine, {
            ...runOptions,
            signal: context.signal,
            onProgress: context.reportProgress,
          })
          context.reportResult(result)
        },
        { indexed: 0, failed: 0, bytesProcessed: 0, bytesTotal: raw.length },
      )
      respondJson(ctx, record, 202)
      return
    }

    const controller = new AbortController()
    ctx.abort.onAbort(() => controller.abort())
    try {
      respondJson(ctx, await runImport(engine, { ...runOptions, signal: controller.signal }))
    } catch (err) {
      if (ctx.abort.aborted) return
      if (err instanceof NdjsonLineTooLongError) {
        sendError(ctx.res, 413, ServerErrorCodes.PAYLOAD_TOO_LARGE, err.message, { line: err.lineNumber })
        return
      }
      respondError(ctx, err)
    }
  }
}
