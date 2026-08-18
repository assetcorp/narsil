/**
 * Every code a {@link NarsilError} carries, grouped by the part of the engine
 * that raises it.
 *
 * Match on the code rather than on the message, because a code is stable and a
 * message is not. The HTTP server maps each code to a status, so a code also
 * tells you whether the caller or the engine is at fault.
 *
 * @public
 */
export const ErrorCodes = {
  SCHEMA_INVALID_TYPE: 'SCHEMA_INVALID_TYPE',
  SCHEMA_MISSING_FIELD: 'SCHEMA_MISSING_FIELD',
  SCHEMA_DEPTH_EXCEEDED: 'SCHEMA_DEPTH_EXCEEDED',
  SCHEMA_INVALID_VECTOR_DIMENSION: 'SCHEMA_INVALID_VECTOR_DIMENSION',
  SCHEMA_INVALID_GEOPOINT: 'SCHEMA_INVALID_GEOPOINT',
  DOC_NOT_FOUND: 'DOC_NOT_FOUND',
  DOC_ALREADY_EXISTS: 'DOC_ALREADY_EXISTS',
  DOC_VALIDATION_FAILED: 'DOC_VALIDATION_FAILED',
  INDEX_NOT_FOUND: 'INDEX_NOT_FOUND',
  INDEX_ALREADY_EXISTS: 'INDEX_ALREADY_EXISTS',
  INDEX_ORPHANED: 'INDEX_ORPHANED',
  PARTITION_CORRUPTED: 'PARTITION_CORRUPTED',
  PARTITION_REBALANCING_BACKPRESSURE: 'PARTITION_REBALANCING_BACKPRESSURE',
  WORKER_CRASHED: 'WORKER_CRASHED',
  WORKER_BUSY: 'WORKER_BUSY',
  WORKER_TIMEOUT: 'WORKER_TIMEOUT',
  PERSISTENCE_SAVE_FAILED: 'PERSISTENCE_SAVE_FAILED',
  PERSISTENCE_LOAD_FAILED: 'PERSISTENCE_LOAD_FAILED',
  PERSISTENCE_DELETE_FAILED: 'PERSISTENCE_DELETE_FAILED',
  PERSISTENCE_CRC_MISMATCH: 'PERSISTENCE_CRC_MISMATCH',
  PERSISTENCE_WAL_CORRUPT: 'PERSISTENCE_WAL_CORRUPT',
  PERSISTENCE_FSYNC_FAILED: 'PERSISTENCE_FSYNC_FAILED',
  SEARCH_INVALID_FIELD: 'SEARCH_INVALID_FIELD',
  SEARCH_INVALID_VECTOR_SIZE: 'SEARCH_INVALID_VECTOR_SIZE',
  VECTOR_DIMENSION_MISMATCH: 'VECTOR_DIMENSION_MISMATCH',
  SEARCH_INVALID_FILTER: 'SEARCH_INVALID_FILTER',
  SEARCH_INVALID_MODE: 'SEARCH_INVALID_MODE',
  SEARCH_INVALID_CURSOR: 'SEARCH_INVALID_CURSOR',
  SEARCH_RESULT_WINDOW_EXCEEDED: 'SEARCH_RESULT_WINDOW_EXCEEDED',
  LANGUAGE_NOT_SUPPORTED: 'LANGUAGE_NOT_SUPPORTED',
  ENVELOPE_VERSION_MISMATCH: 'ENVELOPE_VERSION_MISMATCH',
  ENVELOPE_INVALID_MAGIC: 'ENVELOPE_INVALID_MAGIC',
  PARTITION_CAPACITY_EXCEEDED: 'PARTITION_CAPACITY_EXCEEDED',
  EMBEDDING_FAILED: 'EMBEDDING_FAILED',
  EMBEDDING_DIMENSION_MISMATCH: 'EMBEDDING_DIMENSION_MISMATCH',
  EMBEDDING_NO_SOURCE: 'EMBEDDING_NO_SOURCE',
  EMBEDDING_CONFIG_INVALID: 'EMBEDDING_CONFIG_INVALID',
  DOC_MISSING_REQUIRED_FIELD: 'DOC_MISSING_REQUIRED_FIELD',
  CONFIG_INVALID: 'CONFIG_INVALID',
  QUERY_ROUTING_FAILED: 'QUERY_ROUTING_FAILED',
  QUERY_PARTIAL_FAILURE: 'QUERY_PARTIAL_FAILURE',
  QUERY_NODE_TIMEOUT: 'QUERY_NODE_TIMEOUT',
  QUERY_NO_ACTIVE_REPLICA: 'QUERY_NO_ACTIVE_REPLICA',
  CLUSTER_OPERATION_UNSUPPORTED: 'CLUSTER_OPERATION_UNSUPPORTED',
  ALLOCATION_NO_DATA_NODES: 'ALLOCATION_NO_DATA_NODES',
  ALLOCATION_INVALID_CONFIG: 'ALLOCATION_INVALID_CONFIG',
  ALLOCATION_FAILED: 'ALLOCATION_FAILED',
  CONTROLLER_LEASE_LOST: 'CONTROLLER_LEASE_LOST',
  CONTROLLER_NOT_ACTIVE: 'CONTROLLER_NOT_ACTIVE',
  CONTROLLER_METADATA_INVALID: 'CONTROLLER_METADATA_INVALID',
  NODE_BOOTSTRAP_FAILED: 'NODE_BOOTSTRAP_FAILED',
  NODE_ALREADY_JOINED: 'NODE_ALREADY_JOINED',
  NODE_NOT_JOINED: 'NODE_NOT_JOINED',
  COORDINATOR_DEPENDENCY_MISSING: 'COORDINATOR_DEPENDENCY_MISSING',
  TRANSPORT_DEPENDENCY_MISSING: 'TRANSPORT_DEPENDENCY_MISSING',
  REPLICATION_ENTRY_INVALID: 'REPLICATION_ENTRY_INVALID',
  REPLICATION_INSYNC_REMOVAL_FAILED: 'REPLICATION_INSYNC_REMOVAL_FAILED',
  REPLICATION_ROLLBACK_FAILED: 'REPLICATION_ROLLBACK_FAILED',
  REPLICATION_LOG_FULL: 'REPLICATION_LOG_FULL',
  REPLICATION_ENTRY_CORRUPT: 'REPLICATION_ENTRY_CORRUPT',
  REPLICATION_SNAPSHOT_CORRUPT: 'REPLICATION_SNAPSHOT_CORRUPT',
  REPLICATION_TERM_MISMATCH: 'REPLICATION_TERM_MISMATCH',
  REPLICATION_SYNC_FAILED: 'REPLICATION_SYNC_FAILED',
  PARTITION_NOT_PRIMARY: 'PARTITION_NOT_PRIMARY',
  PARTITION_UNASSIGNED: 'PARTITION_UNASSIGNED',
  INSUFFICIENT_REPLICAS: 'INSUFFICIENT_REPLICAS',
  SNAPSHOT_SYNC_UNAUTHORIZED: 'SNAPSHOT_SYNC_UNAUTHORIZED',
  SNAPSHOT_SYNC_REQUEST_INVALID: 'SNAPSHOT_SYNC_REQUEST_INVALID',
  SNAPSHOT_SYNC_INDEX_NOT_FOUND: 'SNAPSHOT_SYNC_INDEX_NOT_FOUND',
  SNAPSHOT_SYNC_TOO_LARGE: 'SNAPSHOT_SYNC_TOO_LARGE',
  SNAPSHOT_SYNC_CAPACITY_EXHAUSTED: 'SNAPSHOT_SYNC_CAPACITY_EXHAUSTED',
  SNAPSHOT_SYNC_SNAPSHOT_FAILED: 'SNAPSHOT_SYNC_SNAPSHOT_FAILED',
  SNAPSHOT_SYNC_DECODE_FAILED: 'SNAPSHOT_SYNC_DECODE_FAILED',
  SNAPSHOT_SYNC_FRAME_INVALID: 'SNAPSHOT_SYNC_FRAME_INVALID',
  SNAPSHOT_SYNC_HEADER_INVALID: 'SNAPSHOT_SYNC_HEADER_INVALID',
  SNAPSHOT_SYNC_HEADER_MISMATCH: 'SNAPSHOT_SYNC_HEADER_MISMATCH',
  SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER: 'SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER',
  SNAPSHOT_SYNC_CHUNK_OVERFLOW: 'SNAPSHOT_SYNC_CHUNK_OVERFLOW',
  SNAPSHOT_SYNC_CHUNK_SIZE_EXCEEDED: 'SNAPSHOT_SYNC_CHUNK_SIZE_EXCEEDED',
  SNAPSHOT_SYNC_CHUNK_MISSING: 'SNAPSHOT_SYNC_CHUNK_MISSING',
  SNAPSHOT_SYNC_END_MISSING: 'SNAPSHOT_SYNC_END_MISSING',
  SNAPSHOT_SYNC_CHECKSUM_MISMATCH: 'SNAPSHOT_SYNC_CHECKSUM_MISMATCH',
  SNAPSHOT_SYNC_PRIMARY_ERROR: 'SNAPSHOT_SYNC_PRIMARY_ERROR',
  SNAPSHOT_SYNC_NO_TARGETS: 'SNAPSHOT_SYNC_NO_TARGETS',
  SNAPSHOT_SYNC_TRANSPORT_FAILED: 'SNAPSHOT_SYNC_TRANSPORT_FAILED',
  SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE: 'SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE',
  SNAPSHOT_SYNC_RESTORE_FAILED: 'SNAPSHOT_SYNC_RESTORE_FAILED',
  SNAPSHOT_SYNC_RESTORE_CLEANUP_FAILED: 'SNAPSHOT_SYNC_RESTORE_CLEANUP_FAILED',
  SNAPSHOT_SYNC_TIMEOUT: 'SNAPSHOT_SYNC_TIMEOUT',
  SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE: 'SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE',
  SNAPSHOT_SYNC_NOT_ASSIGNED: 'SNAPSHOT_SYNC_NOT_ASSIGNED',
  SNAPSHOT_SYNC_ABORTED: 'SNAPSHOT_SYNC_ABORTED',
} as const

/**
 * Any one of the codes in {@link ErrorCodes}, which is the type to narrow on
 * when you branch on a failure the engine raised.
 *
 * @public
 */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/**
 * Every code the HTTP layer raises for a failure that arises before or around
 * the engine call, such as parsing the body, enforcing a limit, or routing.
 *
 * The engine raises none of these, so a failure carrying one of them says the
 * request never reached the engine.
 *
 * @public
 */
export const ServerErrorCodes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_JSON: 'INVALID_JSON',
  EMPTY_BODY: 'EMPTY_BODY',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  NOT_FOUND: 'NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_NOT_CANCELLABLE: 'TASK_NOT_CANCELLABLE',
  TASK_OWNED_BY_ANOTHER_INSTANCE: 'TASK_OWNED_BY_ANOTHER_INSTANCE',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  HOOK_ERROR: 'HOOK_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

/**
 * Any one of the codes in {@link ServerErrorCodes}.
 *
 * @public
 */
export type ServerErrorCode = (typeof ServerErrorCodes)[keyof typeof ServerErrorCodes]

/**
 * Every code the HTTP client raises when a request never reaches a server, or
 * when the client cannot read the answer.
 *
 * No server sends one of these, so a failure under one of them means the
 * exchange broke before the operation ran. `STATUS_BY_CODE` in
 * `src/server/errors.ts` therefore maps none of them, because no request can
 * arrive under one and no HTTP status belongs to one.
 *
 * @public
 */
export const ClientErrorCodes = {
  CLIENT_CONNECTION_FAILED: 'CLIENT_CONNECTION_FAILED',
  CLIENT_REQUEST_TIMEOUT: 'CLIENT_REQUEST_TIMEOUT',
  CLIENT_REQUEST_ABORTED: 'CLIENT_REQUEST_ABORTED',
  CLIENT_INVALID_RESPONSE: 'CLIENT_INVALID_RESPONSE',
  CLIENT_TASK_TIMEOUT: 'CLIENT_TASK_TIMEOUT',
  CLIENT_UNEXPECTED_ERROR: 'CLIENT_UNEXPECTED_ERROR',
} as const

/**
 * Any one of the codes in {@link ClientErrorCodes}.
 *
 * @public
 */
export type ClientErrorCode = (typeof ClientErrorCodes)[keyof typeof ClientErrorCodes]

/**
 * Every code a {@link NarsilError} can carry: one the engine raised, one the
 * HTTP layer raised, one the client raised, or any other string.
 *
 * The last arm exists for a server's `onRequest` hook, which rejects a request
 * under a code of its own, such as `UNAUTHORIZED`, and the client then passes
 * that code through unchanged. An editor still completes every code Narsil
 * defines.
 *
 * @public
 */
export type NarsilErrorCode = ErrorCode | ServerErrorCode | ClientErrorCode | (string & {})

/**
 * The error every part of the engine throws.
 *
 * Catch it, read {@link NarsilError.code} to decide what to do, and read
 * {@link NarsilError.details} for the values that caused it. The engine lets
 * this error propagate unchanged, so the code you catch is the code the
 * failing operation raised.
 *
 * @public
 */
export class NarsilError extends Error {
  /** This says which failure it is. */
  readonly code: NarsilErrorCode
  /** This carries the values behind the failure, such as the field, index, or limit involved. It is empty when the code says everything. */
  readonly details: Record<string, unknown>

  /**
   * Builds an error carrying a code the caller can branch on.
   *
   * @param code - The failure this error reports, from {@link ErrorCodes} for
   * an engine failure, {@link ServerErrorCodes} for one the HTTP layer raised,
   * or {@link ClientErrorCodes} for one that stopped a request from reaching a
   * server.
   * @param message - Plain description, for a log or a person.
   * @param details - Values behind the failure, which reach
   * {@link NarsilError.details}.
   */
  constructor(code: NarsilErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'NarsilError'
    this.code = code
    this.details = details ?? {}
  }
}

export function createNarsilError(
  code: NarsilErrorCode,
  message: string,
  details?: Record<string, unknown>,
): NarsilError {
  return new NarsilError(code, message, details)
}
