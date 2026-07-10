import type { EmbeddingAdapter } from '../types/adapters'
import type { AnyDocument, InsertOptions } from '../types/schema'

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
  /** Ceiling for a search's `limit`, `offset`, and `group.maxPerGroup`, so one
   * request cannot ask for an unbounded result set. Excess → 400. Defaults to
   * 10000, matching the cluster query result window. */
  maxResultWindow?: number
  /** Ceiling for the number of document ids in one multi-get request, so one
   * request cannot pull an unbounded number of documents. Excess → 400.
   * Defaults to 10000. */
  maxFetchDocuments?: number
}

export interface ServerOptions {
  host?: string
  port?: number
  cors?: boolean | CorsOptions
  /** Authentication or admission gate run before every routed request. */
  onRequest?: OnRequestHook
  /**
   * Build identity reported verbatim at `/version`: the package version and the
   * git commit the server was built from, with a dirty-tree flag. Supply it from
   * the build (a stamped env var or build arg); omit it and `/version` reports
   * nulls. The values are descriptive only and never gate a request.
   */
  build?: { version?: string; gitSha?: string; dirty?: boolean }
  /**
   * Named embedding adapters a JSON `createIndex` request can reference by name.
   * Embedding adapters are functions and cannot cross JSON, so an index that
   * needs query-time or ingest-time embedding names a server-registered adapter.
   */
  embeddingAdapters?: Record<string, EmbeddingAdapter>
  limits?: ServerLimits
  /**
   * Backing store for long-running task records. Defaults to an in-memory store
   * that is lost on restart and not shared across instances. Supply any store
   * that satisfies {@link TaskStore} (Redis, Upstash over HTTP, DynamoDB, a
   * database) to survive restarts and share task status across instances.
   */
  taskStore?: TaskStore
  /**
   * Stable identifier for this server instance, stamped on every task it owns.
   * Supply a stable value (a pod or container name) so that after a restart the
   * instance can mark its own previously-running tasks as failed instead of
   * leaving them stuck. Defaults to a random id, which disables that recovery.
   */
  instanceId?: string
  /**
   * Allows binding to a non-loopback address without an {@link onRequest} auth
   * hook. The server otherwise refuses to start in that configuration because it
   * exposes destructive admin endpoints. Set this only when the address is on a
   * trusted private network where access is controlled elsewhere.
   */
  allowInsecure?: boolean
}

/**
 * Pluggable backing store for task records. Every method is async so any
 * backend works — an in-memory map, Redis, an HTTP key-value service, or a
 * database. `set` upserts by `record.id`; `get` returns null for an unknown id.
 * `ttlMs`, when honored by the backend, expires the record so terminal tasks do
 * not accumulate. The server never calls a method that mutates a record it did
 * not construct, so a backend may treat records as immutable snapshots.
 */
export interface TaskStore {
  set(record: TaskRecord, ttlMs?: number): Promise<void>
  get(id: string): Promise<TaskRecord | null>
  list(): Promise<TaskRecord[]>
  delete(id: string): Promise<void>
  shutdown?(): Promise<void>
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
  /** Identifier of the server instance running this task; see ServerOptions.instanceId. */
  owner: string
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

export interface InsertBody {
  document: AnyDocument
  id?: string
  options?: InsertOptions
}

export interface DocumentBody {
  document: AnyDocument
}

export interface MultiGetBody {
  docIds: string[]
}

export interface BatchBody {
  action?: 'insert' | 'update' | 'delete'
  documents?: AnyDocument[]
  updates?: Array<{ docId: string; document: AnyDocument }>
  docIds?: string[]
  options?: InsertOptions
}

export interface RebalanceBody {
  targetPartitionCount?: number
}

export interface HttpIndexConfig {
  schema: Record<string, unknown>
  language?: string
  partitions?: { maxDocsPerPartition?: number; maxPartitions?: number }
  defaultScoring?: 'local' | 'dfs' | 'broadcast'
  bm25?: { k1?: number; b?: number }
  stopWords?: string[]
  trackPositions?: boolean
  surfaceForms?: boolean
  vectorPromotion?: Record<string, unknown>
  strict?: boolean
  embedding?: CreateIndexEmbedding
  required?: string[]
}
