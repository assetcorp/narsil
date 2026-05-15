import { encode } from '@msgpack/msgpack'
import { type ErrorCode, ErrorCodes, NarsilError } from '../../errors'
import { SNAPSHOT_CHUNK_SIZE } from '../replication/snapshot-constants'
import type {
  ReplicationSnapshotHeader,
  SnapshotChunkPayload,
  SnapshotEndPayload,
  SnapshotStartPayload,
  TransportMessage,
} from '../transport/types'
import { MAX_MESSAGE_SIZE_BYTES, ReplicationMessageTypes } from '../transport/types'
import type { SnapshotBuildResult } from './snapshot-cache'

export const SNAPSHOT_SYNC_ERROR_TYPE = `${ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST}.error`

const CHUNK_YIELD_INTERVAL_MS = 8

export interface SnapshotHeaderMetadata {
  partitionId: number
  primaryTerm: number
  lastSeqNo: number
}

export interface SingleResponseSink {
  (response: TransportMessage): void
  closed: boolean
}

export function createSingleResponseSink(respond: (response: TransportMessage) => void): SingleResponseSink {
  const sink = ((response: TransportMessage) => {
    if (sink.closed) {
      return
    }
    respond(response)
  }) as SingleResponseSink
  sink.closed = false
  return sink
}

export async function streamSnapshotToReplica(
  sink: SingleResponseSink,
  nodeId: string,
  requestId: string,
  indexName: string,
  build: SnapshotBuildResult,
  metadata: SnapshotHeaderMetadata,
): Promise<void> {
  const snapshotBytes = build.bytes
  const totalBytes = snapshotBytes.byteLength
  const checksum = build.checksum

  const header: ReplicationSnapshotHeader = {
    lastSeqNo: metadata.lastSeqNo,
    primaryTerm: metadata.primaryTerm,
    partitionId: metadata.partitionId,
    indexName,
    checksum,
  }

  const startPayload: SnapshotStartPayload = { header, totalBytes }
  const startBytes = encode(startPayload)
  assertMessageWithinLimit(startBytes, 'SNAPSHOT_START')
  respondMessage(sink, ReplicationMessageTypes.SNAPSHOT_START, nodeId, requestId, startBytes)

  // Yield immediately after SNAPSHOT_START so a single-chunk snapshot still
  // gives the event loop a breath before the chunk emission, and the first
  // chunk is not charged against the yield budget of later chunks.
  await yieldToEventLoop()

  let offset = 0
  let lastYieldAt = now()
  while (offset < totalBytes) {
    const end = Math.min(offset + SNAPSHOT_CHUNK_SIZE, totalBytes)
    const chunk = snapshotBytes.subarray(offset, end)

    const chunkPayload: SnapshotChunkPayload = {
      partitionId: metadata.partitionId,
      indexName,
      offset,
      data: chunk,
    }
    const chunkBytes = encode(chunkPayload)
    assertMessageWithinLimit(chunkBytes, 'SNAPSHOT_CHUNK')
    respondMessage(sink, ReplicationMessageTypes.SNAPSHOT_CHUNK, nodeId, requestId, chunkBytes)

    offset = end

    if (offset < totalBytes && now() - lastYieldAt >= CHUNK_YIELD_INTERVAL_MS) {
      await yieldToEventLoop()
      lastYieldAt = now()
    }
  }

  // Yield once more before SNAPSHOT_END so a burst of chunks cannot keep the
  // loop blocked for the entire tail of the stream on a multi-chunk snapshot.
  await yieldToEventLoop()

  const endPayload: SnapshotEndPayload = {
    partitionId: metadata.partitionId,
    indexName,
    totalBytes,
    checksum,
  }
  const endBytes = encode(endPayload)
  assertMessageWithinLimit(endBytes, 'SNAPSHOT_END')
  respondMessage(sink, ReplicationMessageTypes.SNAPSHOT_END, nodeId, requestId, endBytes)
  sink.closed = true
}

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve)
      return
    }
    setTimeout(resolve, 0)
  })
}

function respondMessage(
  sink: SingleResponseSink,
  type: string,
  sourceId: string,
  requestId: string,
  payload: Uint8Array,
): void {
  sink({ type, sourceId, requestId, payload })
}

function assertMessageWithinLimit(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength > MAX_MESSAGE_SIZE_BYTES) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `${label} payload (${bytes.byteLength} bytes) exceeds transport message limit (${MAX_MESSAGE_SIZE_BYTES})`,
    )
  }
}

export function respondError(
  sink: SingleResponseSink,
  sourceId: string,
  requestId: string,
  code: ErrorCode | string,
  message: string,
): void {
  const response: TransportMessage = {
    type: SNAPSHOT_SYNC_ERROR_TYPE,
    sourceId,
    requestId,
    payload: encode({ error: true, code, message }),
  }
  sink(response)
  sink.closed = true
}
