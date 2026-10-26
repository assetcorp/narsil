import { encode } from '@msgpack/msgpack'
import { type ErrorCode, ErrorCodes, NarsilError } from '../../errors'
import { SNAPSHOT_CHUNK_SIZE } from '../replication/constants'
import { MAX_MESSAGE_SIZE_BYTES } from '../transport/constants'
import type {
  ReplicationSnapshotHeader,
  RespondFn,
  SnapshotChunkPayload,
  SnapshotEndPayload,
  SnapshotStartPayload,
  TransportMessage,
} from '../transport/types'
import { ReplicationMessageTypes } from '../transport/types'
import { SNAPSHOT_CHUNK_YIELD_INTERVAL_MS } from './constants'
import { encodeErrorReply } from './error-reply'
import type { SnapshotBuildResult } from './snapshot-cache'

export const SNAPSHOT_SYNC_ERROR_TYPE = `${ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST}.error`

export interface SnapshotHeaderMetadata {
  partitionId: number
  primaryTerm: number
  lastSeqNo: number
}

export interface SingleResponseSink {
  (response: TransportMessage): Promise<void>
  closed: boolean
}

export interface StreamSnapshotOptions {
  closeOnEnd?: boolean
}

export function createSingleResponseSink(respond: RespondFn): SingleResponseSink {
  const sink = ((response: TransportMessage): Promise<void> => {
    if (sink.closed) {
      return Promise.resolve()
    }
    return respond(response)
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
  options: StreamSnapshotOptions = {},
): Promise<void> {
  const totalBytes = build.totalBytes
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
  await respondMessage(sink, ReplicationMessageTypes.SNAPSHOT_START, nodeId, requestId, startBytes)

  await yieldToEventLoop()

  let offset = 0
  let lastYieldAt = now()
  for await (const source of build.read()) {
    for (let from = 0; from < source.byteLength; from += SNAPSHOT_CHUNK_SIZE) {
      const chunk = source.subarray(from, Math.min(from + SNAPSHOT_CHUNK_SIZE, source.byteLength))
      const chunkPayload: SnapshotChunkPayload = {
        partitionId: metadata.partitionId,
        indexName,
        offset,
        data: chunk,
      }
      const chunkBytes = encode(chunkPayload)
      assertMessageWithinLimit(chunkBytes, 'SNAPSHOT_CHUNK')
      await respondMessage(sink, ReplicationMessageTypes.SNAPSHOT_CHUNK, nodeId, requestId, chunkBytes)
      offset += chunk.byteLength
      if (offset < totalBytes && now() - lastYieldAt >= SNAPSHOT_CHUNK_YIELD_INTERVAL_MS) {
        await yieldToEventLoop()
        lastYieldAt = now()
      }
    }
  }

  await yieldToEventLoop()

  const endPayload: SnapshotEndPayload = {
    partitionId: metadata.partitionId,
    indexName,
    totalBytes,
    checksum,
  }
  const endBytes = encode(endPayload)
  assertMessageWithinLimit(endBytes, 'SNAPSHOT_END')
  await respondMessage(sink, ReplicationMessageTypes.SNAPSHOT_END, nodeId, requestId, endBytes)
  if (options.closeOnEnd !== false) {
    sink.closed = true
  }
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
): Promise<void> {
  return sink({ type, sourceId, requestId, payload })
}

function assertMessageWithinLimit(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength > MAX_MESSAGE_SIZE_BYTES) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `${label} payload (${bytes.byteLength} bytes) exceeds transport message limit (${MAX_MESSAGE_SIZE_BYTES})`,
    )
  }
}

export async function respondError(
  sink: SingleResponseSink,
  sourceId: string,
  requestId: string,
  code: ErrorCode | string,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const response: TransportMessage = {
    type: SNAPSHOT_SYNC_ERROR_TYPE,
    sourceId,
    requestId,
    payload: encodeErrorReply(code, message, details),
  }
  await sink(response)
  sink.closed = true
}
