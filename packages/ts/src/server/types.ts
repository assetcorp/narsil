import type { EmbeddingAdapter } from '../types/adapters'

/**
 * Context handed to {@link OnRequestHook} for every inbound request, captured
 * synchronously before any body is read. `remoteAddress` is the peer address
 * decoded from the socket; behind a proxy it is the proxy's address, so trust
 * forwarded headers only when the proxy is trusted.
 */
export interface RequestContext {
  method: string
  path: string
  headers: Record<string, string>
  remoteAddress: string
}

/**
 * Returned by an {@link OnRequestHook} to reject a request. The `status` is sent
 * verbatim as the HTTP status; `code` and `message` populate the error envelope.
 */
export interface RequestDenial {
  status: number
  code: string
  message: string
}

export type OnRequestHook = (ctx: RequestContext) => undefined | RequestDenial | Promise<undefined | RequestDenial>

export interface CorsOptions {
  origin?: string | string[]
  methods?: string[]
  headers?: string[]
}

/**
 * Byte and batch ceilings the server enforces before handing work to the
 * engine. Every field has a safe default; override only to fit a deployment.
 */
export interface ServerLimits {
  /** Cap for JSON request bodies (single doc, batch, search). Excess → 413. */
  maxBodyBytes?: number
  /** Cap for the NDJSON import stream and binary restore body. Excess → 413. */
  maxImportBytes?: number
  /** Cap for a single NDJSON line, so one unterminated line cannot exhaust memory. Excess → 413. */
  maxLineBytes?: number
  /** Documents handed to the engine per batch during NDJSON import; the loop yields between batches. */
  importBatchSize?: number
  /** Maximum requests executing engine work at once; excess is shed with 503. Omit or 0 to disable. */
  maxConcurrentRequests?: number
}

export interface ServerOptions {
  host?: string
  port?: number
  cors?: boolean | CorsOptions
  /** Authentication or admission gate run before every routed request. */
  onRequest?: OnRequestHook
  /**
   * Named embedding adapters a JSON `createIndex` request can reference by name.
   * Embedding adapters are functions and cannot cross JSON, so an index that
   * needs query-time or ingest-time embedding names a server-registered adapter.
   */
  embeddingAdapters?: Record<string, EmbeddingAdapter>
  limits?: ServerLimits
}

export interface NarsilServer {
  listen(): Promise<void>
  close(): Promise<void>
  readonly listeningPort: number
}

export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

export type TaskType = 'optimizeVectors' | 'rebalance' | 'restore'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface TaskRecord {
  id: string
  type: TaskType
  indexName: string
  status: TaskStatus
  createdAt: number
  startedAt?: number
  completedAt?: number
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

/** Declarative index configuration accepted over HTTP. Function-valued engine
 * options (custom tokenizer, stopWords-as-function, group reducer, embedding
 * adapter object) are not representable here; the embedding adapter is named
 * instead via {@link CreateIndexEmbedding}. */
export interface CreateIndexRequest {
  name: string
  config: HttpIndexConfig
}

export interface CreateIndexEmbedding {
  adapter?: string
  fields: Record<string, string | string[]>
}

export interface HttpIndexConfig {
  schema: Record<string, unknown>
  language?: string
  partitions?: { maxDocsPerPartition?: number; maxPartitions?: number }
  defaultScoring?: 'local' | 'dfs' | 'broadcast'
  bm25?: { k1?: number; b?: number }
  stopWords?: string[]
  trackPositions?: boolean
  vectorPromotion?: Record<string, unknown>
  strict?: boolean
  embedding?: CreateIndexEmbedding
  required?: string[]
}
