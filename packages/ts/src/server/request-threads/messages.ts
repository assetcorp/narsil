import type { MessagePort } from 'node:worker_threads'
import type { VectorQueryConfig } from '../../types/search'
import type { ResolvedCors } from '../cors'
import type { ResolvedBuild, ResolvedLimits } from '../deps'
import type { ServerHandlers } from '../routes'
import type { RequestContext, RequestDenial } from '../types'

/**
 * Everything a worker needs to receive HTTP requests as a request thread.
 *
 * @internal
 */
export interface RequestThreadSettings {
  /** The thread sends every request it cannot answer itself down this port, and asks it for each authorisation. */
  port: MessagePort
  /** The requests in flight on every thread count in this shared memory, one slot per thread. */
  gate: SharedArrayBuffer
  /** The slot of the shared memory this thread counts its own requests in. */
  gateSlot: number
  /** The server accepts this many requests at once across every thread, or every request where zero. */
  maxConcurrentRequests: number
  /** The thread tells the main thread it read an index at most this often, so the copies stay loaded under read load. */
  touchIntervalMs: number
  /** The cross-origin rules the thread writes on each response, or null where the server allows none. */
  cors: ResolvedCors | null
  /** The byte and count ceilings the thread applies before it runs a handler. */
  limits: ResolvedLimits
  /** The build identity the thread reports at `/version`. */
  build: ResolvedBuild
  /** True where the server runs an admission hook, which the thread asks the main thread to run per request. */
  authorizes: boolean
  /** True where a plugin observes searches, so the thread sends every search to the main thread. */
  searchHooks: boolean
}

/**
 * The routes a request thread answers on its own whatever index the request
 * names, because each carries data the thread already holds.
 *
 * @internal
 */
export type ThreadOnlyRoute = 'livez' | 'version' | 'capabilities'

/**
 * The names of the routes a request thread sends to the main thread whole.
 *
 * @internal
 */
export type RelayedRoute = Exclude<keyof ServerHandlers, ThreadOnlyRoute>

export interface RelayedRequest {
  type: 'request'
  requestId: number
  route: RelayedRoute
  params: string[]
  query: string
  contentType: string
  rawBody: Uint8Array | null
  hookContext: RequestContext | null
}

export interface AuthorizeRequest {
  type: 'authorize'
  requestId: number
  context: RequestContext
}

export interface EmbedQueryRequest {
  type: 'embed'
  requestId: number
  indexName: string
  vector: VectorQueryConfig
}

export interface TouchIndexNote {
  type: 'touch'
  indexName: string
}

export type RelayRequest = RelayedRequest | AuthorizeRequest | EmbedQueryRequest | TouchIndexNote

export interface RelayedResponse {
  type: 'response'
  requestId: number
  status: number
  headers: Array<[string, string]>
  body: Uint8Array
}

export interface AuthorizedReply {
  type: 'authorized'
  requestId: number
  denial: RequestDenial | null
  hookError: boolean
}

export interface EmbeddedReply {
  type: 'embedded'
  requestId: number
  value: number[] | null
  error: { code: string; message: string; details?: Record<string, unknown> } | null
}

export type RelayReply = RelayedResponse | AuthorizedReply | EmbeddedReply

export interface ServeRequestsResult {
  descriptor: unknown
}
