import { decode, encode } from '@msgpack/msgpack'
import { type ErrorCode, ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import { crc32 } from '../../serialization/crc32'
import type { ClusterCoordinator } from '../coordinator/types'
import {
  MAX_SNAPSHOT_SIZE_BYTES,
  SNAPSHOT_CHUNK_SIZE,
  SNAPSHOT_HEADER_SENTINEL_PARTITION_ID,
  SNAPSHOT_HEADER_SENTINEL_SEQNO,
} from '../replication/snapshot-constants'
import type {
  ReplicationSnapshotHeader,
  SnapshotChunkPayload,
  SnapshotEndPayload,
  SnapshotStartPayload,
  SnapshotSyncRequestPayload,
  TransportMessage,
} from '../transport/types'
import { MAX_MESSAGE_SIZE_BYTES, ReplicationMessageTypes } from '../transport/types'
import { authorizeSnapshotRequest } from './snapshot-auth'
import {
  acquireSnapshotBuild,
  acquireSourceSlot,
  createSnapshotCacheState,
  DEFAULT_MAX_CONCURRENT_SNAPSHOTS,
  DEFAULT_MAX_PER_SOURCE_SNAPSHOTS,
  releaseSourceSlot,
  type SnapshotBuildResult,
  type SnapshotCacheState,
  type SourceSlotHandle,
} from './snapshot-cache'

export const SNAPSHOT_SYNC_ERROR_TYPE = `${ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST}.error`

const MAX_INDEX_NAME_LENGTH = 256
const INDEX_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

const CHUNK_YIELD_INTERVAL_MS = 8

export type SnapshotSyncHandlerState = SnapshotCacheState

export { DEFAULT_MAX_CONCURRENT_SNAPSHOTS, DEFAULT_MAX_PER_SOURCE_SNAPSHOTS }

export function createSnapshotSyncHandlerState(
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT_SNAPSHOTS,
  maxPerSource: number = DEFAULT_MAX_PER_SOURCE_SNAPSHOTS,
): SnapshotSyncHandlerState {
  return createSnapshotCacheState(maxConcurrent, maxPerSource)
}

export interface SnapshotHeaderMetadata {
  partitionId: number
  primaryTerm: number
  lastSeqNo: number
}

export type SnapshotHeaderMetadataProvider = (
  indexName: string,
) => Promise<SnapshotHeaderMetadata> | SnapshotHeaderMetadata

export async function defaultSnapshotHeaderMetadataProvider(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<SnapshotHeaderMetadata> {
  try {
    const allocation = await coordinator.getAllocation(indexName)
    if (allocation !== null) {
      for (const assignment of allocation.assignments.values()) {
        if (Number.isInteger(assignment.primaryTerm) && assignment.primaryTerm >= 0) {
          return {
            partitionId: SNAPSHOT_HEADER_SENTINEL_PARTITION_ID,
            primaryTerm: assignment.primaryTerm,
            lastSeqNo: SNAPSHOT_HEADER_SENTINEL_SEQNO,
          }
        }
      }
    }
  } catch (_) {
    /* fall through to sentinel values when allocation lookup fails */
  }
  return {
    partitionId: SNAPSHOT_HEADER_SENTINEL_PARTITION_ID,
    primaryTerm: 0,
    lastSeqNo: SNAPSHOT_HEADER_SENTINEL_SEQNO,
  }
}

export interface SnapshotSyncHandlerDeps {
  nodeId: string
  engine: Narsil
  coordinator: ClusterCoordinator
  state: SnapshotSyncHandlerState
  resolveHeaderMetadata?: SnapshotHeaderMetadataProvider
}

export async function handleSnapshotSyncRequest(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: SnapshotSyncHandlerDeps,
): Promise<void> {
  const sink = createSingleResponseSink(respond)
  try {
    await runSnapshotSyncRequest(message, sink, deps)
  } catch (err) {
    const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED
    const errMessage = err instanceof Error ? err.message : String(err)
    respondError(sink, deps.nodeId, message.requestId, code, errMessage)
  }
}

async function runSnapshotSyncRequest(
  message: TransportMessage,
  sink: SingleResponseSink,
  deps: SnapshotSyncHandlerDeps,
): Promise<void> {
  let request: SnapshotSyncRequestPayload
  try {
    const decoded = decode(message.payload) as unknown
    request = validateSnapshotSyncRequestPayload(decoded)
  } catch (err) {
    const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID
    const errMessage = err instanceof Error ? err.message : String(err)
    respondError(sink, deps.nodeId, message.requestId, code, errMessage)
    return
  }

  if (typeof message.sourceId !== 'string' || message.sourceId.length === 0) {
    respondError(
      sink,
      deps.nodeId,
      message.requestId,
      ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
      'request sourceId is missing',
    )
    return
  }

  const authResult = await authorizeSnapshotRequest(deps.coordinator, request.indexName, message.sourceId)
  if (authResult.outcome === 'denied') {
    respondError(sink, deps.nodeId, message.requestId, authResult.code, authResult.reason)
    return
  }

  const existingIndex = deps.engine.listIndexes().find(idx => idx.name === request.indexName)
  if (existingIndex === undefined) {
    respondError(
      sink,
      deps.nodeId,
      message.requestId,
      ErrorCodes.SNAPSHOT_SYNC_INDEX_NOT_FOUND,
      `Index '${request.indexName}' is not hosted on this node`,
    )
    return
  }

  let sourceHandle: SourceSlotHandle
  try {
    sourceHandle = acquireSourceSlot(deps.state, message.sourceId)
  } catch (err) {
    const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED
    const errMessage = err instanceof Error ? err.message : String(err)
    respondError(sink, deps.nodeId, message.requestId, code, errMessage)
    return
  }

  try {
    let build: SnapshotBuildResult
    try {
      build = await acquireSnapshotBuild(deps.state, request.indexName, async () =>
        buildSnapshot(deps, request.indexName),
      )
    } catch (err) {
      const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED
      const errMessage = err instanceof Error ? err.message : String(err)
      respondError(sink, deps.nodeId, message.requestId, code, errMessage)
      return
    }

    if (build.bytes.byteLength > MAX_SNAPSHOT_SIZE_BYTES) {
      respondError(
        sink,
        deps.nodeId,
        message.requestId,
        ErrorCodes.SNAPSHOT_SYNC_TOO_LARGE,
        `Snapshot size ${build.bytes.byteLength} exceeds the ${MAX_SNAPSHOT_SIZE_BYTES} byte limit`,
      )
      return
    }

    const metadata = await resolveHeaderMetadata(deps, request.indexName)
    await streamSnapshotToReplica(sink, deps.nodeId, message.requestId, request.indexName, build, metadata)
  } finally {
    releaseSourceSlot(deps.state, sourceHandle)
  }
}

async function buildSnapshot(deps: SnapshotSyncHandlerDeps, indexName: string): Promise<SnapshotBuildResult> {
  let bytes: Uint8Array
  try {
    bytes = await deps.engine.snapshot(indexName)
  } catch (err) {
    if (err instanceof NarsilError) {
      throw err
    }
    const errMessage = err instanceof Error ? err.message : String(err)
    throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED, `engine.snapshot failed: ${errMessage}`, {
      indexName,
      cause: errMessage,
    })
  }
  const checksum = bytes.byteLength <= MAX_SNAPSHOT_SIZE_BYTES ? crc32(bytes) : 0
  return { bytes, checksum }
}

async function resolveHeaderMetadata(
  deps: SnapshotSyncHandlerDeps,
  indexName: string,
): Promise<SnapshotHeaderMetadata> {
  const provider = deps.resolveHeaderMetadata
  if (provider === undefined) {
    return defaultSnapshotHeaderMetadataProvider(deps.coordinator, indexName)
  }
  try {
    return await provider(indexName)
  } catch (_) {
    return {
      partitionId: SNAPSHOT_HEADER_SENTINEL_PARTITION_ID,
      primaryTerm: 0,
      lastSeqNo: SNAPSHOT_HEADER_SENTINEL_SEQNO,
    }
  }
}

interface SingleResponseSink {
  (response: TransportMessage): void
  closed: boolean
}

function createSingleResponseSink(respond: (response: TransportMessage) => void): SingleResponseSink {
  const sink = ((response: TransportMessage) => {
    if (sink.closed) {
      return
    }
    respond(response)
  }) as SingleResponseSink
  sink.closed = false
  return sink
}

async function streamSnapshotToReplica(
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

  const endPayload: SnapshotEndPayload = {
    partitionId: metadata.partitionId,
    indexName,
    totalBytes,
    checksum,
  }
  const endBytes = encode(endPayload)
  assertMessageWithinLimit(endBytes, 'SNAPSHOT_END')
  respondMessage(sink, ReplicationMessageTypes.SNAPSHOT_END, nodeId, requestId, endBytes)
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

function respondError(
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

/**
 * Forward-compatible validator: unknown top-level fields are tolerated so
 * future protocol versions can add optional hints without breaking older peers.
 * All required fields are validated strictly.
 */
export function validateSnapshotSyncRequestPayload(decoded: unknown): SnapshotSyncRequestPayload {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
      'Invalid SnapshotSyncRequestPayload: expected an object',
    )
  }
  const record = decoded as Record<string, unknown>
  const indexName = record.indexName
  if (typeof indexName !== 'string' || indexName.length === 0) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
      'Invalid SnapshotSyncRequestPayload: "indexName" must be a non-empty string',
    )
  }
  if (indexName.length > MAX_INDEX_NAME_LENGTH) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
      `Invalid SnapshotSyncRequestPayload: "indexName" must be at most ${MAX_INDEX_NAME_LENGTH} characters`,
      { length: indexName.length, limit: MAX_INDEX_NAME_LENGTH },
    )
  }
  if (!INDEX_NAME_PATTERN.test(indexName) || indexName.includes('..')) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
      'Invalid SnapshotSyncRequestPayload: "indexName" contains invalid characters',
    )
  }
  return { indexName }
}
