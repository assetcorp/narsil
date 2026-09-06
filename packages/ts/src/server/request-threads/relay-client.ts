import type { MessagePort } from 'node:worker_threads'
import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorQueryConfig } from '../../types/search'
import { ServerErrorCodes } from '../errors'
import type { Authorization, RouteContext } from '../request'
import { type ResponseSink, sendError, sendRelayed } from '../response'
import type { RequestContext } from '../types'
import type { EmbeddedReply, RelayedRoute, RelayReply } from './messages'

/**
 * A request thread's side of the port to the main thread: it sends whole
 * requests, authorisations, and query embeddings, matches each reply to the
 * caller waiting for it, and tells the main thread which indexes the thread
 * has read so that their copies stay loaded.
 *
 * @internal
 */
export interface RelayClient {
  authorize(context: RequestContext): Promise<Authorization>
  request(route: RelayedRoute, ctx: RouteContext): Promise<void>
  embed(indexName: string, vector: VectorQueryConfig): Promise<number[]>
  touch(indexName: string): void
  close(): void
}

function isRelayReply(message: unknown): message is RelayReply {
  if (typeof message !== 'object' || message === null) return false
  const { type, requestId } = message as { type?: unknown; requestId?: unknown }
  return typeof requestId === 'number' && (type === 'response' || type === 'authorized' || type === 'embedded')
}

function errorOf(reply: EmbeddedReply): NarsilError {
  const error = reply.error ?? { code: ErrorCodes.EMBEDDING_FAILED, message: 'The main thread returned no vector' }
  return new NarsilError(error.code as never, error.message, error.details)
}

function portClosedError(): NarsilError {
  return new NarsilError(ErrorCodes.WORKER_CRASHED, 'The port to the main thread closed before it answered')
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

  port.on('message', (message: unknown) => {
    if (!isRelayReply(message)) return
    const waiting = pending.get(message.requestId)
    if (waiting === undefined) return
    pending.delete(message.requestId)
    waiting.resolve(message)
  })
  port.on('close', failAll)

  function send(build: (requestId: number) => unknown): Promise<RelayReply> {
    if (closed) return Promise.reject(portClosedError())
    nextRequestId += 1
    const requestId = nextRequestId
    return new Promise<RelayReply>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      port.postMessage(build(requestId))
    })
  }

  return {
    async authorize(context) {
      let reply: RelayReply
      try {
        reply = await send(requestId => ({ type: 'authorize', requestId, context }))
      } catch {
        return { allowed: false, denial: null }
      }
      if (reply.type !== 'authorized') return { allowed: false, denial: null }
      if (reply.hookError) return { allowed: false, denial: null }
      if (reply.denial !== null) return { allowed: false, denial: reply.denial }
      return { allowed: true }
    },
    async request(route, ctx) {
      let reply: RelayReply
      try {
        reply = await send(requestId => ({
          type: 'request',
          requestId,
          route,
          params: ctx.params,
          query: ctx.query.toString(),
          contentType: ctx.contentType,
          rawBody: ctx.rawBody === null ? null : new Uint8Array(ctx.rawBody),
          hookContext: ctx.hookContext,
        }))
      } catch {
        if (!ctx.abort.aborted) sendUnavailable(ctx.res)
        return
      }
      if (reply.type !== 'response' || ctx.abort.aborted) return
      sendRelayed(ctx.res, ctx.abort, reply.status, reply.headers, reply.body)
    },
    async embed(indexName, vector) {
      const reply = await send(requestId => ({ type: 'embed', requestId, indexName, vector }))
      if (reply.type !== 'embedded' || reply.value === null) {
        throw reply.type === 'embedded'
          ? errorOf(reply)
          : new NarsilError(ErrorCodes.EMBEDDING_FAILED, 'The main thread returned no vector')
      }
      return reply.value
    },
    touch(indexName) {
      if (closed) return
      const now = Date.now()
      const last = touchedAt.get(indexName)
      if (last !== undefined && now - last < touchIntervalMs) return
      touchedAt.set(indexName, now)
      port.postMessage({ type: 'touch', indexName })
    },
    close() {
      failAll()
      port.close()
    },
  }
}
