import { decode } from '@msgpack/msgpack'
import { type ErrorCode, ErrorCodes, NarsilError } from '../../errors'
import type {
  ReplicationSnapshotHeader,
  SnapshotChunkPayload,
  SnapshotEndPayload,
  SnapshotStartPayload,
} from '../transport/types'
import {
  applyChunkPayload,
  applyEndPayload,
  applyErrorEnvelope,
  applyStartPayload,
  classifyFrameShape,
  fail,
  type SnapshotStreamExpectation,
  type SnapshotStreamFailure,
  type SnapshotStreamState,
} from './snapshot-stream-apply'

export type { SnapshotStreamExpectation, SnapshotStreamFailure, SnapshotStreamState }

export interface SnapshotStreamSuccess {
  ok: true
  bytes: Uint8Array
  header: ReplicationSnapshotHeader
  end: SnapshotEndPayload
}

export type SnapshotStreamResult = SnapshotStreamSuccess | SnapshotStreamFailure

export function createSnapshotStreamState(expectation: SnapshotStreamExpectation): SnapshotStreamState {
  return {
    expectation,
    header: null,
    totalBytes: null,
    assembled: null,
    accumulatedBytes: 0,
    expectedNextOffset: 0,
    endPayload: null,
    failure: null,
    firstFrameSeen: false,
  }
}

/**
 * Seed the assembler with an out-of-band SNAPSHOT_START so subsequent frames
 * feed directly into chunk/end handling. Used by the live-replication path,
 * which receives SNAPSHOT_START via request/response and the chunks via stream.
 */
export function seedSnapshotStreamStart(state: SnapshotStreamState, start: SnapshotStartPayload): void {
  if (state.firstFrameSeen) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID, 'snapshot stream already seeded with SNAPSHOT_START')
    return
  }
  applyStartPayload(state, start as unknown as Record<string, unknown>)
  state.firstFrameSeen = true
}

export function handleIncomingSnapshotFrame(state: SnapshotStreamState, frame: Uint8Array): void {
  if (state.failure !== null) {
    return
  }

  if (!(frame instanceof Uint8Array)) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID, 'stream chunk is not a Uint8Array')
    return
  }

  let decoded: unknown
  try {
    decoded = decode(frame)
  } catch (err) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_DECODE_FAILED, 'failed to decode snapshot frame', {
      cause: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    fail(state, ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID, 'snapshot frame is not an object')
    return
  }

  handleIncomingSnapshotRecord(state, decoded as Record<string, unknown>)
}

export function handleIncomingSnapshotRecord(state: SnapshotStreamState, record: Record<string, unknown>): void {
  if (state.failure !== null) {
    return
  }

  if (record.error === true) {
    applyErrorEnvelope(state, record)
    return
  }

  if (!state.firstFrameSeen) {
    state.firstFrameSeen = true
    applyStartPayload(state, record)
    return
  }

  const shape = classifyFrameShape(record)
  if (shape === 'chunk') {
    applyChunkPayload(state, record as unknown as SnapshotChunkPayload)
    return
  }
  if (shape === 'end') {
    applyEndPayload(state, record as unknown as SnapshotEndPayload)
    return
  }

  fail(state, ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID, 'unrecognised snapshot frame shape')
}

export function finalizeSnapshotStream(state: SnapshotStreamState): SnapshotStreamResult {
  if (state.failure !== null) {
    return state.failure
  }
  if (state.header === null || state.totalBytes === null || state.assembled === null) {
    return {
      ok: false,
      code: ErrorCodes.SNAPSHOT_SYNC_CHUNK_MISSING,
      message: 'stream ended before SNAPSHOT_START was received',
      details: { indexName: state.expectation.indexName },
    }
  }
  if (state.endPayload === null) {
    return {
      ok: false,
      code: ErrorCodes.SNAPSHOT_SYNC_END_MISSING,
      message: 'stream ended without SNAPSHOT_END',
      details: {
        indexName: state.expectation.indexName,
        receivedBytes: state.accumulatedBytes,
        totalBytes: state.totalBytes,
      },
    }
  }
  if (state.accumulatedBytes !== state.totalBytes) {
    return {
      ok: false,
      code: ErrorCodes.SNAPSHOT_SYNC_CHUNK_MISSING,
      message: 'stream ended with byte count mismatch',
      details: {
        indexName: state.expectation.indexName,
        receivedBytes: state.accumulatedBytes,
        totalBytes: state.totalBytes,
      },
    }
  }
  return {
    ok: true,
    bytes: state.assembled,
    header: state.header,
    end: state.endPayload,
  }
}

export function toStreamFailure(err: unknown, defaultCode: ErrorCode, defaultMessage: string): SnapshotStreamFailure {
  if (err instanceof NarsilError) {
    return {
      ok: false,
      code: err.code,
      message: err.message,
      details: { ...err.details },
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return {
    ok: false,
    code: defaultCode,
    message: `${defaultMessage}: ${message}`,
    details: { cause: message },
  }
}
