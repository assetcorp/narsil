import { type ErrorCode, ErrorCodes } from '../../errors'
import type {
  ReplicationSnapshotHeader,
  SnapshotChunkPayload,
  SnapshotEndPayload,
  SnapshotStartPayload,
} from '../transport/types'
import { MAX_SNAPSHOT_SIZE_BYTES, SNAPSHOT_CHUNK_SIZE } from './snapshot-constants'

export interface SnapshotStreamFailure {
  ok: false
  code: ErrorCode
  message: string
  details: Record<string, unknown>
}

export interface SnapshotStreamExpectation {
  indexName: string
  partitionId: number | null
}

export interface SnapshotStreamState {
  expectation: SnapshotStreamExpectation
  header: ReplicationSnapshotHeader | null
  totalBytes: number | null
  assembled: Uint8Array | null
  accumulatedBytes: number
  expectedNextOffset: number
  endPayload: SnapshotEndPayload | null
  failure: SnapshotStreamFailure | null
  firstFrameSeen: boolean
}

export function fail(
  state: SnapshotStreamState,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): void {
  if (state.failure !== null) {
    return
  }
  state.failure = { ok: false, code, message, details }
}

export function applyErrorEnvelope(state: SnapshotStreamState, record: Record<string, unknown>): void {
  const code = typeof record.code === 'string' && record.code.length > 0 ? record.code : 'UNKNOWN_ERROR'
  const message =
    typeof record.message === 'string' && record.message.length > 0 ? record.message : 'primary returned error envelope'
  fail(state, ErrorCodes.SNAPSHOT_SYNC_PRIMARY_ERROR, `primary error: ${message}`, {
    primaryCode: code,
    primaryMessage: message,
  })
}

export function applyStartPayload(state: SnapshotStreamState, record: Record<string, unknown>): void {
  if (!isValidStartPayload(record)) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_INVALID, 'expected SNAPSHOT_START as first frame')
    return
  }
  const start = record as unknown as SnapshotStartPayload
  const header = start.header

  if (header.indexName !== state.expectation.indexName) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_MISMATCH, 'snapshot header indexName mismatch', {
      expected: state.expectation.indexName,
      received: header.indexName,
    })
    return
  }
  if (state.expectation.partitionId !== null && header.partitionId !== state.expectation.partitionId) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_MISMATCH, 'snapshot header partitionId mismatch', {
      expected: state.expectation.partitionId,
      received: header.partitionId,
    })
    return
  }
  if (!isSafeNonNegativeInteger(header.checksum)) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_INVALID, 'header.checksum must be a non-negative integer')
    return
  }
  if (!isSafeNonNegativeInteger(header.partitionId)) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_INVALID, 'header.partitionId must be a non-negative integer')
    return
  }
  if (!isSafeNonNegativeInteger(header.lastSeqNo)) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_INVALID, 'header.lastSeqNo must be a non-negative integer')
    return
  }
  if (!isSafeNonNegativeInteger(header.primaryTerm)) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_INVALID, 'header.primaryTerm must be a non-negative integer')
    return
  }
  if (!isSafeNonNegativeInteger(start.totalBytes)) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_INVALID, 'totalBytes must be a non-negative integer')
    return
  }
  if (start.totalBytes > MAX_SNAPSHOT_SIZE_BYTES) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_TOO_LARGE, `totalBytes ${start.totalBytes} exceeds the limit`, {
      totalBytes: start.totalBytes,
      limit: MAX_SNAPSHOT_SIZE_BYTES,
    })
    return
  }

  state.header = header
  state.totalBytes = start.totalBytes
  state.assembled = new Uint8Array(start.totalBytes)
}

export function applyChunkPayload(state: SnapshotStreamState, payload: SnapshotChunkPayload): void {
  if (state.totalBytes === null || state.assembled === null || state.header === null) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID, 'received chunk before SNAPSHOT_START')
    return
  }
  if (!isSafeNonNegativeInteger(payload.offset)) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER, 'chunk offset must be a non-negative integer')
    return
  }
  if (!isSafeNonNegativeInteger(payload.partitionId)) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_MISMATCH, 'chunk partitionId must be a non-negative integer')
    return
  }
  if (payload.indexName !== state.header.indexName) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_MISMATCH, 'chunk indexName does not match header', {
      expected: state.header.indexName,
      received: payload.indexName,
    })
    return
  }
  if (payload.partitionId !== state.header.partitionId) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_MISMATCH, 'chunk partitionId does not match header', {
      expected: state.header.partitionId,
      received: payload.partitionId,
    })
    return
  }
  if (payload.offset !== state.expectedNextOffset) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER, 'chunk arrived out of order', {
      expected: state.expectedNextOffset,
      received: payload.offset,
    })
    return
  }
  if (!(payload.data instanceof Uint8Array)) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID, 'chunk data is not Uint8Array')
    return
  }
  const remainingBytes = state.totalBytes - state.accumulatedBytes
  const perChunkLimit = Math.min(SNAPSHOT_CHUNK_SIZE, remainingBytes)
  if (payload.data.byteLength > perChunkLimit) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_CHUNK_SIZE_EXCEEDED, 'chunk exceeds the per-chunk size limit', {
      chunkBytes: payload.data.byteLength,
      limit: perChunkLimit,
    })
    return
  }
  const nextBytes = state.accumulatedBytes + payload.data.byteLength
  if (nextBytes > state.totalBytes) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_CHUNK_OVERFLOW, 'chunk overflow beyond declared totalBytes', {
      nextBytes,
      totalBytes: state.totalBytes,
    })
    return
  }
  state.assembled.set(payload.data, payload.offset)
  state.accumulatedBytes = nextBytes
  state.expectedNextOffset = payload.offset + payload.data.byteLength
}

export function applyEndPayload(state: SnapshotStreamState, payload: SnapshotEndPayload): void {
  if (state.header === null || state.totalBytes === null) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID, 'received SNAPSHOT_END before SNAPSHOT_START')
    return
  }
  if (payload.indexName !== state.header.indexName) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_MISMATCH, 'end indexName does not match header', {
      expected: state.header.indexName,
      received: payload.indexName,
    })
    return
  }
  if (payload.partitionId !== state.header.partitionId) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_MISMATCH, 'end partitionId does not match header', {
      expected: state.header.partitionId,
      received: payload.partitionId,
    })
    return
  }
  if (!isSafeNonNegativeInteger(payload.totalBytes) || payload.totalBytes !== state.totalBytes) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_HEADER_MISMATCH, 'end totalBytes does not match SNAPSHOT_START', {
      expected: state.totalBytes,
      received: payload.totalBytes,
    })
    return
  }
  if (!isSafeNonNegativeInteger(payload.checksum) || payload.checksum !== state.header.checksum) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_CHECKSUM_MISMATCH, 'end checksum does not match header', {
      expected: state.header.checksum,
      received: payload.checksum,
    })
    return
  }
  state.endPayload = payload
}

export function classifyFrameShape(record: Record<string, unknown>): 'chunk' | 'end' | 'unknown' {
  const hasOffset = typeof record.offset === 'number'
  const hasData = record.data instanceof Uint8Array
  const hasChecksum = typeof record.checksum === 'number'
  const hasTotalBytes = typeof record.totalBytes === 'number'
  const hasPartitionId = typeof record.partitionId === 'number'
  const hasIndexName = typeof record.indexName === 'string'

  if (!hasPartitionId || !hasIndexName) {
    return 'unknown'
  }

  if (hasOffset && hasData && !hasChecksum && !hasTotalBytes) {
    return 'chunk'
  }

  if (hasTotalBytes && hasChecksum && !hasOffset && !hasData) {
    return 'end'
  }

  return 'unknown'
}

function isValidStartPayload(record: Record<string, unknown>): boolean {
  if (typeof record.totalBytes !== 'number') {
    return false
  }
  const header = record.header
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    return false
  }
  const headerRecord = header as Record<string, unknown>
  return (
    typeof headerRecord.indexName === 'string' &&
    typeof headerRecord.checksum === 'number' &&
    typeof headerRecord.partitionId === 'number' &&
    typeof headerRecord.lastSeqNo === 'number' &&
    typeof headerRecord.primaryTerm === 'number'
  )
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}
