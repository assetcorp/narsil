import type { ClusterNamespace } from '../../distribution/cluster-node/types'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { TaskStore } from './tasks'

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
  /** Maximum requests executing engine work at once; excess is shed with 429. Omit or 0 to disable. */
  maxConcurrentRequests?: number
  /** Ceiling for a search's `limit`, `offset`, and `group.maxPerGroup`, so one
   * request cannot ask for an unbounded result set. Excess → 400. Defaults to
   * 10000, matching the cluster query result window. */
  maxResultWindow?: number
  /** Ceiling for the number of document ids in one multi-get request, so one
   * request cannot pull an unbounded number of documents. Excess → 400.
   * Defaults to 10000. */
  maxFetchDocuments?: number
  /** Ceiling for how many per-line failures one import reports and stores, so a
   * corpus of bad records cannot produce an unbounded response or task record.
   * Excess failures still count towards the reported total. Defaults to 100. */
  maxImportErrors?: number
  /** Ceiling for how many task records one `/tasks` page returns. Excess → 400. Defaults to 1000. */
  maxTaskPageSize?: number
  /** Ceiling for how many tasks this instance drives at once; excess is shed
   * with 429. Each running task holds its own working set, and an async import
   * holds the whole uploaded corpus until it finishes, so this is what bounds
   * the memory a burst of task requests can claim. Defaults to 4. Set 0 to
   * accept every task. */
  maxConcurrentTasks?: number
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
  /**
   * The cluster-facing side of the node this server fronts, which is
   * `node.cluster` on a {@link ClusterNode}. With it set, `/readyz` answers
   * 200 only while the node reports `SERVING`, `/cluster` reports the
   * topology, and `/indexes/:name/cluster` reports one index's allocation.
   * Without it, both cluster routes answer 501.
   */
  cluster?: ClusterNamespace
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
