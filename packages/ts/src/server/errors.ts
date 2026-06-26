import { NarsilError } from '../errors'

/** HTTP-layer error codes for failures that arise before or around the engine
 * call (parsing, limits, routing). Engine failures carry their own
 * {@link NarsilError} codes, mapped by {@link httpStatusForNarsilError}. */
export const ServerErrorCodes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_JSON: 'INVALID_JSON',
  EMPTY_BODY: 'EMPTY_BODY',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  NOT_FOUND: 'NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  HOOK_ERROR: 'HOOK_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  REQUEST_ABORTED: 'REQUEST_ABORTED',
} as const

const STATUS_BY_CODE: Record<string, number> = {
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
  LANGUAGE_NOT_SUPPORTED: 400,
  CONFIG_INVALID: 400,
  EMBEDDING_DIMENSION_MISMATCH: 400,
  EMBEDDING_NO_SOURCE: 400,
  EMBEDDING_CONFIG_INVALID: 400,
  INDEX_NOT_FOUND: 404,
  DOC_NOT_FOUND: 404,
  INDEX_ALREADY_EXISTS: 409,
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
}

/** Maps a {@link NarsilError} code to an HTTP status. Unknown or cluster-only
 * codes fall through to 500 so an internal fault never leaks as a client error. */
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
