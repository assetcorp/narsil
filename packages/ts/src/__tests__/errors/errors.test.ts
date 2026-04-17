import { describe, expect, it } from 'vitest'
import { createNarsilError, ErrorCodes, NarsilError } from '../../errors'

describe('ErrorCodes', () => {
  it('has all expected schema error codes', () => {
    expect(ErrorCodes.SCHEMA_INVALID_TYPE).toBe('SCHEMA_INVALID_TYPE')
    expect(ErrorCodes.SCHEMA_MISSING_FIELD).toBe('SCHEMA_MISSING_FIELD')
    expect(ErrorCodes.SCHEMA_DEPTH_EXCEEDED).toBe('SCHEMA_DEPTH_EXCEEDED')
    expect(ErrorCodes.SCHEMA_INVALID_VECTOR_DIMENSION).toBe('SCHEMA_INVALID_VECTOR_DIMENSION')
    expect(ErrorCodes.SCHEMA_INVALID_GEOPOINT).toBe('SCHEMA_INVALID_GEOPOINT')
  })

  it('has all expected document error codes', () => {
    expect(ErrorCodes.DOC_NOT_FOUND).toBe('DOC_NOT_FOUND')
    expect(ErrorCodes.DOC_ALREADY_EXISTS).toBe('DOC_ALREADY_EXISTS')
    expect(ErrorCodes.DOC_VALIDATION_FAILED).toBe('DOC_VALIDATION_FAILED')
  })

  it('has all expected index error codes', () => {
    expect(ErrorCodes.INDEX_NOT_FOUND).toBe('INDEX_NOT_FOUND')
    expect(ErrorCodes.INDEX_ALREADY_EXISTS).toBe('INDEX_ALREADY_EXISTS')
  })

  it('has all expected partition error codes', () => {
    expect(ErrorCodes.PARTITION_CORRUPTED).toBe('PARTITION_CORRUPTED')
    expect(ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE).toBe('PARTITION_REBALANCING_BACKPRESSURE')
  })

  it('has all expected worker error codes', () => {
    expect(ErrorCodes.WORKER_CRASHED).toBe('WORKER_CRASHED')
    expect(ErrorCodes.WORKER_BUSY).toBe('WORKER_BUSY')
    expect(ErrorCodes.WORKER_TIMEOUT).toBe('WORKER_TIMEOUT')
  })

  it('has all expected persistence error codes', () => {
    expect(ErrorCodes.PERSISTENCE_SAVE_FAILED).toBe('PERSISTENCE_SAVE_FAILED')
    expect(ErrorCodes.PERSISTENCE_LOAD_FAILED).toBe('PERSISTENCE_LOAD_FAILED')
    expect(ErrorCodes.PERSISTENCE_DELETE_FAILED).toBe('PERSISTENCE_DELETE_FAILED')
    expect(ErrorCodes.PERSISTENCE_CRC_MISMATCH).toBe('PERSISTENCE_CRC_MISMATCH')
  })

  it('has all expected search error codes', () => {
    expect(ErrorCodes.SEARCH_INVALID_FIELD).toBe('SEARCH_INVALID_FIELD')
    expect(ErrorCodes.SEARCH_INVALID_VECTOR_SIZE).toBe('SEARCH_INVALID_VECTOR_SIZE')
    expect(ErrorCodes.VECTOR_DIMENSION_MISMATCH).toBe('VECTOR_DIMENSION_MISMATCH')
    expect(ErrorCodes.SEARCH_INVALID_FILTER).toBe('SEARCH_INVALID_FILTER')
    expect(ErrorCodes.SEARCH_INVALID_MODE).toBe('SEARCH_INVALID_MODE')
    expect(ErrorCodes.SEARCH_INVALID_CURSOR).toBe('SEARCH_INVALID_CURSOR')
  })

  it('has language and envelope error codes', () => {
    expect(ErrorCodes.LANGUAGE_NOT_SUPPORTED).toBe('LANGUAGE_NOT_SUPPORTED')
    expect(ErrorCodes.ENVELOPE_VERSION_MISMATCH).toBe('ENVELOPE_VERSION_MISMATCH')
    expect(ErrorCodes.ENVELOPE_INVALID_MAGIC).toBe('ENVELOPE_INVALID_MAGIC')
  })

  it('has all expected embedding error codes', () => {
    expect(ErrorCodes.EMBEDDING_FAILED).toBe('EMBEDDING_FAILED')
    expect(ErrorCodes.EMBEDDING_DIMENSION_MISMATCH).toBe('EMBEDDING_DIMENSION_MISMATCH')
    expect(ErrorCodes.EMBEDDING_NO_SOURCE).toBe('EMBEDDING_NO_SOURCE')
    expect(ErrorCodes.EMBEDDING_CONFIG_INVALID).toBe('EMBEDDING_CONFIG_INVALID')
    expect(ErrorCodes.DOC_MISSING_REQUIRED_FIELD).toBe('DOC_MISSING_REQUIRED_FIELD')
  })

  it('has config error codes', () => {
    expect(ErrorCodes.CONFIG_INVALID).toBe('CONFIG_INVALID')
  })

  it('has query routing error codes', () => {
    expect(ErrorCodes.QUERY_ROUTING_FAILED).toBe('QUERY_ROUTING_FAILED')
    expect(ErrorCodes.QUERY_PARTIAL_FAILURE).toBe('QUERY_PARTIAL_FAILURE')
    expect(ErrorCodes.QUERY_NODE_TIMEOUT).toBe('QUERY_NODE_TIMEOUT')
    expect(ErrorCodes.QUERY_NO_ACTIVE_REPLICA).toBe('QUERY_NO_ACTIVE_REPLICA')
  })

  it('has allocation error codes', () => {
    expect(ErrorCodes.ALLOCATION_NO_DATA_NODES).toBe('ALLOCATION_NO_DATA_NODES')
    expect(ErrorCodes.ALLOCATION_INVALID_CONFIG).toBe('ALLOCATION_INVALID_CONFIG')
    expect(ErrorCodes.ALLOCATION_FAILED).toBe('ALLOCATION_FAILED')
    expect(ErrorCodes.NODE_BOOTSTRAP_FAILED).toBe('NODE_BOOTSTRAP_FAILED')
    expect(ErrorCodes.NODE_ALREADY_JOINED).toBe('NODE_ALREADY_JOINED')
    expect(ErrorCodes.NODE_NOT_JOINED).toBe('NODE_NOT_JOINED')
    expect(ErrorCodes.COORDINATOR_DEPENDENCY_MISSING).toBe('COORDINATOR_DEPENDENCY_MISSING')
  })

  it('has all expected snapshot sync error codes', () => {
    expect(ErrorCodes.SNAPSHOT_SYNC_UNAUTHORIZED).toBe('SNAPSHOT_SYNC_UNAUTHORIZED')
    expect(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID).toBe('SNAPSHOT_SYNC_REQUEST_INVALID')
    expect(ErrorCodes.SNAPSHOT_SYNC_INDEX_NOT_FOUND).toBe('SNAPSHOT_SYNC_INDEX_NOT_FOUND')
    expect(ErrorCodes.SNAPSHOT_SYNC_TOO_LARGE).toBe('SNAPSHOT_SYNC_TOO_LARGE')
    expect(ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED).toBe('SNAPSHOT_SYNC_CAPACITY_EXHAUSTED')
    expect(ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED).toBe('SNAPSHOT_SYNC_SNAPSHOT_FAILED')
    expect(ErrorCodes.SNAPSHOT_SYNC_DECODE_FAILED).toBe('SNAPSHOT_SYNC_DECODE_FAILED')
    expect(ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID).toBe('SNAPSHOT_SYNC_FRAME_INVALID')
    expect(ErrorCodes.SNAPSHOT_SYNC_HEADER_INVALID).toBe('SNAPSHOT_SYNC_HEADER_INVALID')
    expect(ErrorCodes.SNAPSHOT_SYNC_HEADER_MISMATCH).toBe('SNAPSHOT_SYNC_HEADER_MISMATCH')
    expect(ErrorCodes.SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER).toBe('SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER')
    expect(ErrorCodes.SNAPSHOT_SYNC_CHUNK_OVERFLOW).toBe('SNAPSHOT_SYNC_CHUNK_OVERFLOW')
    expect(ErrorCodes.SNAPSHOT_SYNC_CHUNK_SIZE_EXCEEDED).toBe('SNAPSHOT_SYNC_CHUNK_SIZE_EXCEEDED')
    expect(ErrorCodes.SNAPSHOT_SYNC_CHUNK_MISSING).toBe('SNAPSHOT_SYNC_CHUNK_MISSING')
    expect(ErrorCodes.SNAPSHOT_SYNC_END_MISSING).toBe('SNAPSHOT_SYNC_END_MISSING')
    expect(ErrorCodes.SNAPSHOT_SYNC_CHECKSUM_MISMATCH).toBe('SNAPSHOT_SYNC_CHECKSUM_MISMATCH')
    expect(ErrorCodes.SNAPSHOT_SYNC_PRIMARY_ERROR).toBe('SNAPSHOT_SYNC_PRIMARY_ERROR')
    expect(ErrorCodes.SNAPSHOT_SYNC_NO_TARGETS).toBe('SNAPSHOT_SYNC_NO_TARGETS')
    expect(ErrorCodes.SNAPSHOT_SYNC_TRANSPORT_FAILED).toBe('SNAPSHOT_SYNC_TRANSPORT_FAILED')
    expect(ErrorCodes.SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE).toBe('SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE')
    expect(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED).toBe('SNAPSHOT_SYNC_RESTORE_FAILED')
    expect(ErrorCodes.SNAPSHOT_SYNC_RESTORE_CLEANUP_FAILED).toBe('SNAPSHOT_SYNC_RESTORE_CLEANUP_FAILED')
    expect(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT).toBe('SNAPSHOT_SYNC_TIMEOUT')
    expect(ErrorCodes.SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE).toBe('SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE')
    expect(ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED).toBe('SNAPSHOT_SYNC_NOT_ASSIGNED')
    expect(ErrorCodes.SNAPSHOT_SYNC_ABORTED).toBe('SNAPSHOT_SYNC_ABORTED')
  })

  it('has exactly 75 error codes', () => {
    expect(Object.keys(ErrorCodes)).toHaveLength(75)
  })

  it('has unique values for every code', () => {
    const values = Object.values(ErrorCodes)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('NarsilError', () => {
  it('extends Error', () => {
    const err = new NarsilError(ErrorCodes.DOC_NOT_FOUND, 'Document not found')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(NarsilError)
  })

  it('sets the name to NarsilError', () => {
    const err = new NarsilError(ErrorCodes.DOC_NOT_FOUND, 'Document not found')
    expect(err.name).toBe('NarsilError')
  })

  it('stores the error code', () => {
    const err = new NarsilError(ErrorCodes.SCHEMA_INVALID_TYPE, 'Invalid type for field "price"')
    expect(err.code).toBe('SCHEMA_INVALID_TYPE')
  })

  it('stores the error message', () => {
    const err = new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'Index "products" does not exist')
    expect(err.message).toBe('Index "products" does not exist')
  })

  it('stores details when provided', () => {
    const details = {
      field: 'price',
      expectedType: 'number',
      receivedType: 'string',
    }
    const err = new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Validation failed', details)
    expect(err.details).toEqual(details)
  })

  it('defaults details to empty object when omitted', () => {
    const err = new NarsilError(ErrorCodes.DOC_NOT_FOUND, 'Not found')
    expect(err.details).toEqual({})
  })

  it('has a usable stack trace', () => {
    const err = new NarsilError(ErrorCodes.DOC_NOT_FOUND, 'Not found')
    expect(err.stack).toBeDefined()
    expect(err.stack).toContain('NarsilError')
  })

  it('can be caught as an Error', () => {
    expect(() => {
      throw new NarsilError(ErrorCodes.WORKER_CRASHED, 'Worker terminated unexpectedly')
    }).toThrow(Error)
  })

  it('can be caught as a NarsilError', () => {
    expect(() => {
      throw new NarsilError(ErrorCodes.WORKER_CRASHED, 'Worker terminated unexpectedly')
    }).toThrow(NarsilError)
  })

  it('preserves details as a reference', () => {
    const details = { partitionId: 3 }
    const err = new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'Partition corrupted', details)
    expect(err.details).toBe(details)
  })
})

describe('createNarsilError', () => {
  it('returns a NarsilError instance', () => {
    const err = createNarsilError(ErrorCodes.DOC_NOT_FOUND, 'Not found')
    expect(err).toBeInstanceOf(NarsilError)
  })

  it('passes code, message, and details through', () => {
    const details = { docId: 'abc-123' }
    const err = createNarsilError(ErrorCodes.DOC_NOT_FOUND, 'Document "abc-123" not found', details)
    expect(err.code).toBe('DOC_NOT_FOUND')
    expect(err.message).toBe('Document "abc-123" not found')
    expect(err.details).toEqual(details)
  })

  it('defaults details to empty object when omitted', () => {
    const err = createNarsilError(ErrorCodes.INDEX_ALREADY_EXISTS, 'Index already exists')
    expect(err.details).toEqual({})
  })
})
