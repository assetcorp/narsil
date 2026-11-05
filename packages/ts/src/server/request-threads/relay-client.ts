import type { MessagePort } from 'node:worker_threads'
import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorQueryConfig } from '../../types/search'
import { ServerErrorCodes } from '../errors'
import type { Authorization, RouteContext } from '../request'
import { type ResponseSink, sendError, sendRelayed, statusLine } from '../response'
import type { FeedAdmittedReply } from '../sync/feed-messages'
import type { RequestContext } from '../types'
import type { EmbeddedReply, RelayedRoute, RelayedStreamPart, RelayReply } from './messages'

export interface RelayClient {
  authorize(context: RequestContext): Promise<Authorization>
  request(route: RelayedRoute, ctx: RouteContext, onUnavailable?: () => void): Promise<void>
  embed(indexName: string, vector: VectorQueryConfig): Promise<number[]>
  rerank(adapter: string, query: string, documents: string[]): Promise<number[]>
  awaitWrites(indexName: string): Promise<void>
  admitFeed(indexName: string, expiresAt: number | null): Promise<FeedAdmittedReply>
  touch(indexName: string): void
  announceDeparture(): void
  close(): void
}

function isRelayReply(message: unknown): message is RelayReply {
  if (typeof message !== 'object' || message === null) return false
  const { type, requestId } = message as { type?: unknown; requestId?: unknown }
  return (
    typeof requestId === 'number' &&
    (type === 'response' ||
      type === 'authorized' ||
      type === 'embedded' ||
      type === 'reranked' ||
      type === 'writes-applied' ||
      type === 'feed-admitted')
  )
}

function isStreamPart(message: unknown): message is RelayedStreamPart {
  if (typeof message !== 'object' || message === null) return false
  const { type, requestId } = message as { type?: unknown; requestId?: unknown }
  return typeof requestId === 'number' && (type === 'stream-start' || type === 'stream-chunk' || type === 'stream-end')
}

interface StreamWriter {
  ctx: RouteContext
  started: boolean
  totalSize: number | null
  sized: SizedWrites
  finish(): void
}

interface SizedWrites {
  queued: Uint8Array[]
  waiting: boolean
}

function writeSizedChunks(port: MessagePort, writer: StreamWriter, totalSize: number, requestId: number): void {
  const { ctx, sized } = writer
  const credit = (): void => port.postMessage({ type: 'stream-credit', requestId })
  while (!sized.waiting && sized.queued.length > 0 && !ctx.abort.aborted) {
    const chunk = sized.queued[0]
    let startOffset = 0
    let written = true
    ctx.res.cork(() => {
      startOffset = ctx.res.getWriteOffset()
      written = ctx.res.tryEnd(chunk, totalSize)[0]
    })
    if (written) {
      sized.queued.shift()
      credit()
      continue
    }
    sized.waiting = true
    ctx.res.onWritable(offset => {
      if (ctx.abort.aborted) return true
      const [retried] = ctx.res.tryEnd(chunk.subarray(offset - startOffset), totalSize)
      if (!retried) return false
      sized.waiting = false
      sized.queued.shift()
      credit()
      queueMicrotask(() => writeSizedChunks(port, writer, totalSize, requestId))
      return true
    })
  }
}

function writeStreamPart(port: MessagePort, writer: StreamWriter, part: RelayedStreamPart): void {
  const { ctx } = writer
  if (part.type === 'stream-end') {
    if (!ctx.abort.aborted && writer.totalSize !== null) {
      if (part.failed) {
        writer.sized.queued.length = 0
        ctx.res.cork(() => ctx.res.close())
      }
    } else if (!ctx.abort.aborted) {
      ctx.res.cork(() => {
        if (part.failed) ctx.res.close()
        else ctx.res.end()
      })
    }
    writer.finish()
    return
  }
  if (ctx.abort.aborted) return
  if (part.type === 'stream-start') {
    writer.started = true
    writer.totalSize = part.totalSize
    ctx.res.cork(() => {
      ctx.res.writeStatus(statusLine(part.status))
      for (const [key, value] of part.headers) ctx.res.writeHeader(key, value)
    })
    return
  }
  if (writer.totalSize !== null) {
    writer.sized.queued.push(part.chunk)
    writeSizedChunks(port, writer, writer.totalSize, part.requestId)
    return
  }
  let writable = true
  ctx.res.cork(() => {
    writable = ctx.res.write(part.chunk)
  })
  const credit = (): void => port.postMessage({ type: 'stream-credit', requestId: part.requestId })
  if (writable) {
    credit()
    return
  }
  ctx.res.onWritable(() => {
    credit()
    return true
  })
}

function relayedErrorOf(error: EmbeddedReply['error'], fallback: NarsilError): NarsilError {
  return error === null ? fallback : new NarsilError(error.code as never, error.message, error.details)
}

function portClosedError(): NarsilError {
  return new NarsilError(ErrorCodes.WORKER_CRASHED, 'The port to the main thread closed before it answered')
}

const SHUTTING_DOWN_DENIAL: Authorization = {
  allowed: false,
  denial: { status: 503, code: ServerErrorCodes.INTERNAL_ERROR, message: 'The server is shutting down' },
}

interface RelayedBody {
  bytes: Uint8Array | null
  moved: ArrayBuffer[]
}

function relayedBody(rawBody: Buffer | null): RelayedBody {
  if (rawBody === null) return { bytes: null, moved: [] }
  const memory = rawBody.buffer
  const ownsItsMemory =
    memory instanceof ArrayBuffer && rawBody.byteOffset === 0 && rawBody.byteLength === memory.byteLength
  if (!ownsItsMemory) return { bytes: new Uint8Array(rawBody), moved: [] }
  return { bytes: new Uint8Array(memory), moved: [memory] }
}

function sendUnavailable(res: ResponseSink): void {
  sendError(res, 503, ServerErrorCodes.INTERNAL_ERROR, 'The server is shutting down')
}

export function createRelayClient(port: MessagePort, touchIntervalMs: number): RelayClient {
  const pending = new Map<number, { resolve: (reply: RelayReply) => void; reject: (err: Error) => void }>()
  const touchedAt = new Map<string, number>()
  let nextRequestId = 0
  let closed = false

  function failAll(): void {
    closed = true
    const waiting = [...pending.values()]
    pending.clear()
    for (const entry of waiting) entry.reject(portClosedError())
  }

  const writers = new Map<number, StreamWriter>()
  port.on('message', (message: unknown) => {
    if (isStreamPart(message)) {
      const writer = writers.get(message.requestId)
      if (writer !== undefined) writeStreamPart(port, writer, message)
      return
    }
    if (!isRelayReply(message)) return
    const waiting = pending.get(message.requestId)
    if (waiting === undefined) return
    pending.delete(message.requestId)
    writers.delete(message.requestId)
    waiting.resolve(message)
  })
  port.on('close', failAll)

  function send(build: (requestId: number) => unknown, moved: ArrayBuffer[] = []): Promise<RelayReply> {
    if (closed) return Promise.reject(portClosedError())
    nextRequestId += 1
    const requestId = nextRequestId
    return new Promise<RelayReply>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      try {
        port.postMessage(build(requestId), moved)
      } catch (err) {
        pending.delete(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  return {
    async authorize(context) {
      let reply: RelayReply
      try {
        reply = await send(requestId => ({ type: 'authorize', requestId, context }))
      } catch {
        return SHUTTING_DOWN_DENIAL
      }
      if (reply.type !== 'authorized') return { allowed: false, denial: null }
      if (reply.hookError) return { allowed: false, denial: null }
      if (reply.denial !== null) return { allowed: false, denial: reply.denial }
      return { allowed: true, expiresAt: reply.expiresAt }
    },
    async request(route, ctx, onUnavailable) {
      let reply: RelayReply | null
      const body = relayedBody(ctx.rawBody)
      try {
        reply = await new Promise<RelayReply | null>((resolve, reject) => {
          void send(requestId => {
            writers.set(requestId, {
              ctx,
              started: false,
              totalSize: null,
              sized: { queued: [], waiting: false },
              finish: () => {
                writers.delete(requestId)
                pending.delete(requestId)
                resolve(null)
              },
            })
            ctx.abort.onAbort(() => port.postMessage({ type: 'stream-cancel', requestId }))
            return {
              type: 'request',
              requestId,
              route,
              params: ctx.params,
              query: ctx.query.toString(),
              contentType: ctx.contentType,
              rawBody: body.bytes,
              bodyRefusal: ctx.bodyRefusal,
              spooledBody:
                ctx.spooledBody === null ? null : { path: ctx.spooledBody.path, bytes: ctx.spooledBody.bytes },
              hookContext: ctx.hookContext,
              requestHeaders: { ...ctx.requestHeaders },
            }
          }, body.moved).then(resolve, reject)
        })
      } catch {
        if (ctx.abort.aborted) return
        if (onUnavailable === undefined) sendUnavailable(ctx.res)
        else onUnavailable()
        return
      }
      if (reply === null || reply.type !== 'response' || ctx.abort.aborted) return
      sendRelayed(ctx.res, ctx.abort, reply.status, reply.headers, reply.body)
    },
    async embed(indexName, vector) {
      const reply = await send(requestId => ({ type: 'embed', requestId, indexName, vector }))
      if (reply.type === 'embedded' && reply.value !== null) return reply.value
      throw relayedErrorOf(
        reply.type === 'embedded' ? reply.error : null,
        new NarsilError(ErrorCodes.EMBEDDING_FAILED, 'The main thread returned no vector'),
      )
    },
    async rerank(adapter, query, documents) {
      const reply = await send(requestId => ({ type: 'rerank', requestId, adapter, query, documents }))
      if (reply.type === 'reranked' && reply.scores !== null) return reply.scores
      throw relayedErrorOf(
        reply.type === 'reranked' ? reply.error : null,
        new NarsilError(ErrorCodes.RERANK_FAILED, 'The main thread returned no scores'),
      )
    },
    async awaitWrites(indexName) {
      await send(requestId => ({ type: 'await-writes', requestId, indexName }))
    },
    async admitFeed(indexName, expiresAt) {
      const reply = await send(requestId => ({ type: 'feed-admit', requestId, indexName, expiresAt }))
      if (reply.type === 'feed-admitted') return reply
      throw portClosedError()
    },
    touch(indexName) {
      if (closed) return
      const now = Date.now()
      const last = touchedAt.get(indexName)
      if (last !== undefined && now - last < touchIntervalMs) return
      touchedAt.set(indexName, now)
      port.postMessage({ type: 'touch', indexName })
    },
    announceDeparture() {
      if (closed) return
      port.postMessage({ type: 'leaving' })
    },
    close() {
      failAll()
      port.close()
    },
  }
}
