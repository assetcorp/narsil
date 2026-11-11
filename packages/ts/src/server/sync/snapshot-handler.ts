import { ErrorCodes, NarsilError } from '../../errors'
import { archiveRange } from '../../persistence/archive/range-layout'
import { SNAPSHOT_ARCHIVE_CONTENT_TYPE } from '../constants'
import { ServerErrorCodes, toHttpError } from '../errors'
import { respondError } from '../handler-utils'
import type { RouteContext, RouteHandler } from '../request'
import { sendError, sendSizedStream, statusLine } from '../response'
import { rangeOf } from './range'
import type { SyncServing } from './serving'

export const SYNC_SNAPSHOT_REQUEST_HEADERS: readonly string[] = ['range', 'if-range']

function refuseRange(ctx: RouteContext, length: number, entityTag: string): void {
  ctx.res.cork(() => {
    ctx.res
      .writeStatus(statusLine(416))
      .writeHeader('Content-Range', `bytes */${length}`)
      .writeHeader('ETag', `"${entityTag}"`)
      .writeHeader('Cache-Control', 'no-store')
      .end()
  })
}

function retryAfterSecondsOf(err: unknown): number | null {
  if (!(err instanceof NarsilError) || err.code !== ErrorCodes.SYNC_SNAPSHOT_PREPARING) return null
  const retryAfterMs = err.details?.retryAfterMs
  return typeof retryAfterMs === 'number' && retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 1
}

function refuseSnapshot(ctx: RouteContext, err: unknown): void {
  const retryAfterSeconds = retryAfterSecondsOf(err)
  if (retryAfterSeconds === null || ctx.abort.aborted) {
    respondError(ctx, err)
    return
  }
  const { status, body } = toHttpError(err)
  sendError(ctx.res, status, body.code, body.message, body.details, [['Retry-After', String(retryAfterSeconds)]])
}

export function createSyncSnapshotHandler(serving: () => SyncServing | null): RouteHandler {
  return async ctx => {
    const sync = serving()
    if (sync === null) {
      sendError(ctx.res, 404, ServerErrorCodes.NOT_FOUND, 'Route not found')
      return
    }
    let download: Awaited<ReturnType<SyncServing['snapshot']>>
    try {
      download = await sync.snapshot(ctx.params[0])
    } catch (err) {
      refuseSnapshot(ctx, err)
      return
    }
    try {
      if (ctx.abort.aborted) return
      const { layout, entityTag } = download
      const length = layout.byteLength
      const answer = rangeOf(ctx.requestHeaders.range, ctx.requestHeaders['if-range'], entityTag, length)
      if (answer.kind === 'unsatisfiable') {
        refuseRange(ctx, length, entityTag)
        return
      }
      const start = answer.kind === 'partial' ? answer.start : 0
      const endExclusive = answer.kind === 'partial' ? answer.endExclusive : length
      const headers: Array<[string, string]> = [
        ['Content-Type', SNAPSHOT_ARCHIVE_CONTENT_TYPE],
        ['ETag', `"${entityTag}"`],
        ['Accept-Ranges', 'bytes'],
        ['Cache-Control', 'no-store'],
      ]
      if (answer.kind === 'partial') headers.push(['Content-Range', `bytes ${start}-${endExclusive - 1}/${length}`])
      await sendSizedStream(
        ctx.res,
        ctx.abort,
        answer.kind === 'partial' ? 206 : 200,
        headers,
        endExclusive - start,
        archiveRange(layout, start, endExclusive),
      )
    } catch (err) {
      respondError(ctx, err)
    } finally {
      download.release()
    }
  }
}
