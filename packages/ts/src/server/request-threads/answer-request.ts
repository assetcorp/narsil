import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { MessagePort } from 'node:worker_threads'
import { ServerErrorCodes } from '../errors'
import type { RouteContext, RouteHandler } from '../request'
import { sendError } from '../response'
import type { SpooledBody } from '../spool'
import { type CapturingResponse, createCapturingResponse, toRelayedResponse } from './captured-response'
import type { RelayedRequest, RelayReply } from './messages'

function spooledBodyOf(relayed: RelayedRequest['spooledBody']): SpooledBody | null {
  if (relayed === null) return null
  return {
    path: relayed.path,
    bytes: relayed.bytes,
    remove: () => rm(path.dirname(relayed.path), { recursive: true, force: true }),
  }
}

export async function answerRequest(
  handler: RouteHandler,
  request: RelayedRequest,
  port: MessagePort,
  streams: Map<number, CapturingResponse>,
): Promise<RelayReply | null> {
  const captured = createCapturingResponse(request.hookContext?.remoteAddress ?? '', request.requestId, (part, moved) =>
    port.postMessage(part, moved),
  )
  streams.set(request.requestId, captured)
  const ctx: RouteContext = {
    res: captured.sink,
    params: request.params,
    query: new URLSearchParams(request.query),
    contentType: request.contentType,
    rawBody:
      request.rawBody === null
        ? null
        : Buffer.from(request.rawBody.buffer, request.rawBody.byteOffset, request.rawBody.byteLength),
    bodyRefusal: request.bodyRefusal,
    spooledBody: spooledBodyOf(request.spooledBody),
    abort: captured.abort,
    hookContext: request.hookContext,
  }
  try {
    await handler(ctx)
  } catch {
    sendError(ctx.res, 500, ServerErrorCodes.INTERNAL_ERROR, 'An unexpected error occurred')
  }
  captured.finishUnanswered()
  const answered = await captured.done
  streams.delete(request.requestId)
  return answered === null ? null : toRelayedResponse(request.requestId, answered)
}
