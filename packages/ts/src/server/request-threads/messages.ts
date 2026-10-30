import type { MessagePort } from 'node:worker_threads'
import type { VectorQueryConfig } from '../../types/search'
import type { ResolvedCors } from '../cors'
import type { ResolvedBuild, ResolvedLimits } from '../deps'
import type { ServerHandlers } from '../routes'
import type { RequestContext, RequestDenial } from '../types'

export interface RequestThreadSettings {
  /** The thread sends every request it cannot answer itself down this port, and asks it for each authorisation. */
  port: MessagePort
  departure: SharedArrayBuffer
  /** The main thread signals here as the process exits, and the thread closes its connections and answers here. */
  closeAtExit: SharedArrayBuffer
  /** The requests in flight on every thread count in this shared memory, one slot per thread. */
  gate: SharedArrayBuffer
  /** The slot of the shared memory this thread counts its own requests in. */
  gateSlot: number
  /** The server accepts this many requests at once across every thread, or every request where zero. */
  maxConcurrentRequests: number
  /** Every thread counts the bytes of the request bodies that it holds in this shared memory, in the same slot as its requests. */
  bodyBudget: SharedArrayBuffer
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
  patternWorkCap: number
  maxRerankWindow: number
  allowRegex: boolean
  /** Every request thread counts here the searches it has handed to the long-query thread and that have not yet answered. */
  longQueriesInFlight: SharedArrayBuffer
}

export interface LongQueryThreadSettings {
  /** The long-query thread asks the main thread down this port to embed, rerank, and answer what its copy cannot. */
  port: MessagePort
  touchIntervalMs: number
  limits: ResolvedLimits
  patternWorkCap: number
  maxRerankWindow: number
  allowRegex: boolean
}

export interface LongQueryPortNote {
  type: 'long-query-port'
  port: MessagePort
}

export function isLongQueryPortNote(message: unknown): message is LongQueryPortNote {
  if (typeof message !== 'object' || message === null) return false
  return (message as { type?: unknown }).type === 'long-query-port'
}

export type ThreadOnlyRoute = 'livez' | 'version' | 'capabilities'

export type RelayedRoute = Exclude<keyof ServerHandlers, ThreadOnlyRoute>

export interface RelayedRequest {
  type: 'request'
  requestId: number
  route: RelayedRoute
  params: string[]
  query: string
  contentType: string
  rawBody: Uint8Array | null
  spooledBody: { path: string; bytes: number } | null
  hookContext: RequestContext | null
}

export interface StreamCreditNote {
  type: 'stream-credit'
  requestId: number
}

export interface StreamCancelNote {
  type: 'stream-cancel'
  requestId: number
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

export interface RerankQueryRequest {
  type: 'rerank'
  requestId: number
  adapter: string
  query: string
  documents: string[]
}

export interface AwaitWritesRequest {
  type: 'await-writes'
  requestId: number
  indexName: string
}

export interface TouchIndexNote {
  type: 'touch'
  indexName: string
}

export interface LeavingNote {
  type: 'leaving'
}

export type RelayRequest =
  | RelayedRequest
  | AuthorizeRequest
  | EmbedQueryRequest
  | RerankQueryRequest
  | AwaitWritesRequest
  | TouchIndexNote
  | LeavingNote
  | StreamCreditNote
  | StreamCancelNote

export interface RelayedStreamStart {
  type: 'stream-start'
  requestId: number
  status: number
  headers: Array<[string, string]>
}

export interface RelayedStreamChunk {
  type: 'stream-chunk'
  requestId: number
  chunk: Uint8Array
}

export interface RelayedStreamEnd {
  type: 'stream-end'
  requestId: number
  failed: boolean
}

export type RelayedStreamPart = RelayedStreamStart | RelayedStreamChunk | RelayedStreamEnd

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

export interface RerankedReply {
  type: 'reranked'
  requestId: number
  scores: number[] | null
  error: { code: string; message: string; details?: Record<string, unknown> } | null
}

export interface WritesAppliedReply {
  type: 'writes-applied'
  requestId: number
}

export type RelayReply = RelayedResponse | AuthorizedReply | EmbeddedReply | RerankedReply | WritesAppliedReply

export interface ServeRequestsResult {
  descriptor: unknown
}
