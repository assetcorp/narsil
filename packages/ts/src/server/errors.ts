import { NarsilError, ServerErrorCodes } from '../errors'

export type { ServerErrorCode } from '../errors'
export { ServerErrorCodes } from '../errors'

/** This maps each code the server can raise to the status it answers with.
 * Every code in `ErrorCodes` and `ServerErrorCodes` belongs here, because a
 * missing one answers 500, and a cluster node served through
 * `clusterNodeEngine` raises the cluster codes on the same routes a single
 * engine raises the rest. The `ClientErrorCodes` are absent on purpose, since
 * the HTTP client raises those and no request can arrive under one. */
const STATUS_BY_CODE: Record<string, number> = {
  INVALID_REQUEST: 400,
  INVALID_JSON: 400,
  EMPTY_BODY: 400,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  TASK_NOT_CANCELLABLE: 409,
  TASK_OWNED_BY_ANOTHER_INSTANCE: 409,
  TASK_INTERRUPTED: 503,
  TOO_MANY_REQUESTS: 429,
  HOOK_ERROR: 500,
  INTERNAL_ERROR: 500,
  ENVELOPE_INVALID_MAGIC: 400,
  ENVELOPE_VERSION_MISMATCH: 400,
  SCHEMA_INVALID_TYPE: 400,
  SCHEMA_MISSING_FIELD: 400,
  SCHEMA_DEPTH_EXCEEDED: 400,
  SCHEMA_INVALID_VECTOR_DIMENSION: 400,
  SCHEMA_INVALID_GEOPOINT: 400,
  DOC_VALIDATION_FAILED: 400,
  DOC_MISSING_REQUIRED_FIELD: 400,
  SEARCH_INVALID_FIELD: 400,
  SEARCH_INVALID_VECTOR_SIZE: 400,
  VECTOR_DIMENSION_MISMATCH: 400,
  SEARCH_INVALID_FILTER: 400,
  SEARCH_INVALID_MODE: 400,
  SEARCH_INVALID_CURSOR: 400,
  SEARCH_RESULT_WINDOW_EXCEEDED: 400,
  LANGUAGE_NOT_SUPPORTED: 400,
  CONFIG_INVALID: 400,
  EMBEDDING_DIMENSION_MISMATCH: 400,
  EMBEDDING_NO_SOURCE: 400,
  EMBEDDING_CONFIG_INVALID: 400,
  INDEX_NOT_FOUND: 404,
  DOC_NOT_FOUND: 404,
  INDEX_ALREADY_EXISTS: 409,
  INDEX_ORPHANED: 409,
  DOC_ALREADY_EXISTS: 409,
  PARTITION_REBALANCING_BACKPRESSURE: 409,
  PARTITION_CAPACITY_EXCEEDED: 409,
  WORKER_BUSY: 429,
  PARTITION_CORRUPTED: 503,
  WORKER_CRASHED: 503,
  WORKER_TIMEOUT: 503,
  PERSISTENCE_SAVE_FAILED: 503,
  PERSISTENCE_LOAD_FAILED: 503,
  PERSISTENCE_DELETE_FAILED: 503,
  PERSISTENCE_CRC_MISMATCH: 503,
  PERSISTENCE_WAL_CORRUPT: 503,
  PERSISTENCE_FSYNC_FAILED: 503,
  EMBEDDING_FAILED: 503,
  QUERY_ROUTING_FAILED: 503,
  QUERY_PARTIAL_FAILURE: 503,
  QUERY_NODE_TIMEOUT: 503,
  QUERY_NO_ACTIVE_REPLICA: 503,
  CLUSTER_OPERATION_UNSUPPORTED: 501,
  REPLICATION_ENTRY_INVALID: 503,
  REPLICATION_INSYNC_REMOVAL_FAILED: 503,
  REPLICATION_ROLLBACK_FAILED: 503,
  REPLICATION_LOG_FULL: 503,
  REPLICATION_ENTRY_CORRUPT: 503,
  REPLICATION_SNAPSHOT_CORRUPT: 503,
  REPLICATION_TERM_MISMATCH: 503,
  REPLICATION_SYNC_FAILED: 503,
  PARTITION_NOT_PRIMARY: 503,
  PARTITION_UNASSIGNED: 503,
  INSUFFICIENT_REPLICAS: 503,
  TRANSPORT_DEPENDENCY_MISSING: 500,
  ALLOCATION_INVALID_CONFIG: 400,
  ALLOCATION_NO_DATA_NODES: 503,
  ALLOCATION_FAILED: 503,
  CONTROLLER_LEASE_LOST: 503,
  CONTROLLER_NOT_ACTIVE: 503,
  NODE_ALREADY_JOINED: 409,
  NODE_NOT_JOINED: 503,
  NODE_NOT_READY: 503,
  NODE_NOT_CONTROLLER: 503,
  NODE_BOOTSTRAP_FAILED: 503,
  COORDINATOR_DEPENDENCY_MISSING: 500,
  SNAPSHOT_SYNC_UNAUTHORIZED: 403,
  SNAPSHOT_SYNC_REQUEST_INVALID: 400,
  SNAPSHOT_SYNC_HEADER_INVALID: 400,
  SNAPSHOT_SYNC_FRAME_INVALID: 400,
  SNAPSHOT_SYNC_INDEX_NOT_FOUND: 404,
  SNAPSHOT_SYNC_TOO_LARGE: 413,
  SNAPSHOT_SYNC_CHUNK_SIZE_EXCEEDED: 413,
  SNAPSHOT_SYNC_ABORTED: 409,
  SNAPSHOT_SYNC_CAPACITY_EXHAUSTED: 503,
  SNAPSHOT_SYNC_SNAPSHOT_FAILED: 503,
  SNAPSHOT_SYNC_DECODE_FAILED: 503,
  SNAPSHOT_SYNC_HEADER_MISMATCH: 503,
  SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER: 503,
  SNAPSHOT_SYNC_CHUNK_OVERFLOW: 503,
  SNAPSHOT_SYNC_CHUNK_MISSING: 503,
  SNAPSHOT_SYNC_END_MISSING: 503,
  SNAPSHOT_SYNC_CHECKSUM_MISMATCH: 503,
  SNAPSHOT_SYNC_PRIMARY_ERROR: 503,
  SNAPSHOT_SYNC_NO_TARGETS: 503,
  SNAPSHOT_SYNC_TRANSPORT_FAILED: 503,
  SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE: 503,
  SNAPSHOT_SYNC_RESTORE_FAILED: 503,
  SNAPSHOT_SYNC_RESTORE_CLEANUP_FAILED: 503,
  SNAPSHOT_SYNC_TIMEOUT: 503,
  SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE: 503,
  SNAPSHOT_SYNC_NOT_ASSIGNED: 503,
  CONTROLLER_METADATA_INVALID: 500,
}

/** Maps a {@link NarsilError} code to an HTTP status. Unknown or cluster-only
 * codes fall through to 500 so an internal fault never leaks as a client error.
 *
 * @param code - The code a {@link NarsilError} carried.
 * @returns The status the server answers with.
 *
 * @public */
export function httpStatusForNarsilError(code: string): number {
  return STATUS_BY_CODE[code] ?? 500
}

export interface SerializedError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export function serializeNarsilError(err: NarsilError): SerializedError {
  const hasDetails = err.details && Object.keys(err.details).length > 0
  return hasDetails
    ? { code: err.code, message: err.message, details: err.details }
    : { code: err.code, message: err.message }
}

/** Translates any thrown value into an HTTP status and a safe error envelope.
 * Engine errors are mapped by code and message; anything else collapses to a
 * generic 500 so stack traces and internal strings never reach the client. */
export function toHttpError(err: unknown): { status: number; body: SerializedError } {
  if (err instanceof NarsilError) {
    return { status: httpStatusForNarsilError(err.code), body: serializeNarsilError(err) }
  }
  return {
    status: 500,
    body: { code: ServerErrorCodes.INTERNAL_ERROR, message: 'An unexpected error occurred' },
  }
}
