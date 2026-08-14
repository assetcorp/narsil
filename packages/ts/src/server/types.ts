import type { EmbeddingAdapter } from '../types/adapters'
import type { AnyDocument, InsertOptions } from '../types/schema'

/**
 * Context handed to {@link OnRequestHook} for every inbound request, captured
 * synchronously before any body is read. `remoteAddress` is the peer address
 * decoded from the socket; behind a proxy it is the proxy's address, so trust
 * forwarded headers only when the proxy is trusted.
 *
 * @public
 */
export interface RequestContext {
  /** The request used this HTTP method, in upper case. */
  method: string
  /** The request asked for this path, without the query string. */
  path: string
  /** These are the request headers, keyed by lower-case name. */
  headers: Record<string, string>
  /** The server decoded this peer address from the socket. */
  remoteAddress: string
}

/**
 * Returned by an {@link OnRequestHook} to reject a request. The `status` is sent
 * verbatim as the HTTP status; `code` and `message` populate the error envelope.
 *
 * @public
 */
export interface RequestDenial {
  /** The server answers with this status. */
  status: number
  /** The error envelope carries this machine-readable code. */
  code: string
  /** The error envelope carries this description. */
  message: string
}

/**
 * Runs before every routed request, which is where authentication, rate
 * limiting, and any other admission rule goes.
 *
 * @param ctx - The request's method, path, headers, and peer address.
 * @returns A {@link RequestDenial} to reject the request, or `undefined` to
 * let it through.
 *
 * @public
 */
export type OnRequestHook = (ctx: RequestContext) => undefined | RequestDenial | Promise<undefined | RequestDenial>

/**
 * Which cross-origin requests the server accepts.
 *
 * Passing `true` for `cors` instead of this object accepts any origin, which
 * suits local development and little else.
 *
 * @public
 */
export interface CorsOptions {
  /** The server allows these origins, given as one origin or a list. */
  origin?: string | string[]
  /** The server allows these methods on a cross-origin request. */
  methods?: string[]
  /** A browser may send these request headers cross-origin. */
  headers?: string[]
}

/**
 * Byte and batch ceilings the server enforces before handing work to the
 * engine. Every field has a safe default; override only to fit a deployment.
 *
 * @public
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

/**
 * Everything {@link createServer} accepts.
 *
 * Every field is optional, and a server created without any of them binds to
 * loopback with the default limits and no authentication.
 *
 * @public
 */
export interface ServerOptions {
  /** The server binds to this address, and to loopback by default. Any other address needs an authentication hook. */
  host?: string
  /** The server binds to this port. Pass 0 to let the operating system choose one, then read {@link NarsilServer.listeningPort}. */
  port?: number
  /** These settings control which cross-origin requests the server accepts, and `true` accepts any origin. */
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
  /** These ceilings apply before the server hands any work to the engine. */
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
   * Allows binding to a non-loopback address without an
   * {@link ServerOptions.onRequest} auth hook. The server otherwise refuses to
   * start in that configuration because it exposes destructive admin endpoints.
   * Set this only when the address is on a trusted private network where access
   * is controlled elsewhere.
   */
  allowInsecure?: boolean
}

/**
 * Pluggable backing store for task records. Every method is async so any
 * backend works: an in-memory map, Redis, an HTTP key-value service, or a
 * database. `set` upserts by `record.id`; `get` returns null for an unknown id.
 * `ttlMs`, when honored by the backend, expires the record so terminal tasks do
 * not accumulate. The server never calls a method that mutates a record it did
 * not construct, so a backend may treat records as immutable snapshots.
 *
 * @public
 */
export interface TaskStore {
  /**
   * Stores a record, replacing whatever its id already held.
   *
   * @param record - The record to store.
   * @param ttlMs - Milliseconds after which the backend may drop it, which
   * keeps finished tasks from accumulating. Ignore it in a backend without
   * expiry.
   */
  set(record: TaskRecord, ttlMs?: number): Promise<void>
  /**
   * Reads one record back.
   *
   * @param id - The task to read.
   * @returns The record, or `null` when the store holds no such id.
   */
  get(id: string): Promise<TaskRecord | null>
  /**
   * Lists every record the store holds.
   *
   * @returns Each record the backend still has.
   */
  list(): Promise<TaskRecord[]>
  /**
   * Removes one record. An id the store never held is not an error.
   *
   * @param id - The task to remove.
   */
  delete(id: string): Promise<void>
  /** Releases whatever the backend holds open, such as a connection pool. */
  shutdown?(): Promise<void>
}

/**
 * The running HTTP server, as {@link createServer} returns it.
 *
 * @public
 */
export interface NarsilServer {
  /**
   * Binds the socket and starts answering requests.
   *
   * @throws An error when the address is already in use, or when a non-loopback
   * address is configured without an authentication hook.
   */
  listen(): Promise<void>
  /** Closes the socket and ends the server. The engine keeps running. */
  close(): Promise<void>
  /** The server bound to this port, which is what you read after binding to port 0. */
  readonly listeningPort: number
}

/**
 * The body every failed response carries, which is what an HTTP client parses
 * on a non-2xx status.
 *
 * @public
 */
export interface ErrorEnvelope {
  /** This describes the failure. */
  error: {
    /** This code comes from either {@link ServerErrorCodes} or {@link ErrorCodes}. */
    code: string
    /** This describes the failure, for a log or a person. */
    message: string
    /** These values are behind the failure, such as the field or limit involved. */
    details?: Record<string, unknown>
  }
}

/**
 * Which long-running operation a task record tracks.
 *
 * @public
 */
export type TaskType = 'optimizeVectors' | 'rebalance' | 'restore'

/**
 * Where a long-running operation stands.
 *
 * @public
 */
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed'

/**
 * One long-running operation, which the server answers with straight away and
 * you then poll.
 *
 * @public
 */
export interface TaskRecord {
  /** This identifies the task, and is what you poll by. */
  id: string
  /** This says which operation the task runs. */
  type: TaskType
  /** The operation runs against this index. */
  indexName: string
  /** This says where the operation stands. */
  status: TaskStatus
  /** Identifier of the server instance running this task; see ServerOptions.instanceId. */
  owner: string
  /** The server accepted the task at this many milliseconds since the epoch. */
  createdAt: number
  /** Work started at this many milliseconds since the epoch, and a queued task omits it. */
  startedAt?: number
  /** Work ended at this many milliseconds since the epoch, and a task omits it until it succeeds or fails. */
  completedAt?: number
  /** This says why the task failed, and a failed task alone carries it. */
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

/** Declarative index configuration accepted over HTTP. Function-valued engine
 * options (custom tokenizer, stopWords-as-function, group reducer, embedding
 * adapter object) are not representable here; the embedding adapter is named
 * instead via {@link CreateIndexEmbedding}.
 *
 * @public */
export interface CreateIndexRequest {
  /** The server creates the index under this name. */
  name: string
  /** This carries the schema and settings, in the subset JSON can express. */
  config: HttpIndexConfig
}

/**
 * How a JSON `createIndex` request connects an index to an embedding adapter.
 *
 * An adapter is a function and cannot cross JSON, so the request names one the
 * server registered instead of carrying it.
 *
 * @public
 */
export interface CreateIndexEmbedding {
  /** This names an adapter the server registered under `embeddingAdapters`. */
  adapter?: string
  /** This maps each vector field to the text field, or fields, the server embeds into it. */
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

/**
 * The index settings a JSON request can carry, which is {@link IndexConfig}
 * minus everything that is a function.
 *
 * A custom tokeniser, a stop-word function, and an embedding adapter object
 * have no JSON form, so an HTTP client names a registered one or supplies a
 * plain list instead.
 *
 * @public
 */
export interface HttpIndexConfig {
  /** This layout gives each value as either a field type or a nested schema. */
  schema: Record<string, unknown>
  /** The server tokenises and stems text fields with the language module registered under this name. */
  language?: string
  /** These settings control how the index splits documents across partitions as it grows. */
  partitions?: { maxDocsPerPartition?: number; maxPartitions?: number; watermark?: number }
  /** A query scores this way unless it asks for another mode. */
  defaultScoring?: 'local' | 'dfs' | 'broadcast'
  /** These parameters tune BM25 for this index. */
  bm25?: { k1?: number; b?: number }
  /** This list replaces the language's stop words. */
  stopWords?: string[]
  /** Setting this records term positions, which phrase queries and highlighting need. */
  trackPositions?: boolean
  /** Setting this to false returns index stems from suggestions and prefix expansion, instead of the words users typed. */
  surfaceForms?: boolean
  /** These settings control when vector fields move to an HNSW graph, and how that graph is built. */
  vectorPromotion?: Record<string, unknown>
  /** Setting this rejects a document carrying a field the schema does not declare. */
  strict?: boolean
  /** This names a server-registered embedding adapter and the fields it embeds. */
  embedding?: CreateIndexEmbedding
  /** The server rejects a document that omits any of these fields. */
  required?: string[]
}
