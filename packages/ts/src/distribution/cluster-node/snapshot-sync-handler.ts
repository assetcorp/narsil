import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import { crc32 } from '../../serialization/crc32'
import type { ClusterCoordinator } from '../coordinator/types'
import {
  MAX_SNAPSHOT_SIZE_BYTES,
  SNAPSHOT_HEADER_SENTINEL_PARTITION_ID,
  SNAPSHOT_HEADER_SENTINEL_SEQNO,
} from '../replication/snapshot-constants'
import type { SnapshotSyncRequestPayload, TransportMessage } from '../transport/types'
import { authorizeSnapshotRequest } from './snapshot-auth'
import {
  acquireSnapshotBuild,
  acquireSourceSlot,
  acquireStreamSlot,
  createSnapshotCacheState,
  DEFAULT_MAX_CONCURRENT_SNAPSHOTS,
  DEFAULT_MAX_PER_SOURCE_SNAPSHOTS,
  DEFAULT_MAX_STREAMS_PER_INDEX,
  releaseSourceSlot,
  releaseStreamSlot,
  type SnapshotBuildResult,
  type SnapshotCacheState,
  type SourceSlotHandle,
  type StreamSlotHandle,
} from './snapshot-cache'
import {
  createSingleResponseSink,
  respondError,
  type SingleResponseSink,
  SNAPSHOT_SYNC_ERROR_TYPE,
  streamSnapshotToReplica,
} from './snapshot-stream-writer'

export { SNAPSHOT_SYNC_ERROR_TYPE }

const MAX_INDEX_NAME_LENGTH = 256
const INDEX_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

const MAX_SOURCE_ID_LENGTH = 256

/**
 * Control characters in a sourceId would collide with our per-source slot key
 * separator (NUL) and could let an authorized replica forge a key that aliases
 * another replica's slot. Beyond NUL, reject the full ASCII C0 + DEL set, the
 * Unicode C1 control range, the line and paragraph separators, and the BOM,
 * because all of these confuse log viewers, audit trails, and any future
 * normalization-aware comparator. Reject the whole class at the trust boundary
 * before any slot acquisition or engine work. Uses a character-code scan
 * rather than a regex to avoid embedding control characters in source
 * (biome's noControlCharactersInRegex).
 */
function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20) {
      return true
    }
    if (code >= 0x7f && code <= 0x9f) {
      return true
    }
    if (code === 0x2028 || code === 0x2029 || code === 0xfeff) {
      return true
    }
  }
  return false
}

/**
 * A SNAPSHOT_SYNC_REQUEST only carries `{indexName: string}` with `indexName <= 256`.
 * Rejecting oversized payloads before msgpack decode keeps an abusive peer from
 * pinning a CPU on a 64 MiB decode just to fail validation.
 */
const MAX_SNAPSHOT_SYNC_REQUEST_BYTES = 4_096

/**
 * The request payload is a single-field map: `{indexName: string}`. Cap the
 * decoder's structural limits so a deeply nested or wide map within the 4 KiB
 * byte budget can't run the decoder's inner loop long enough to matter. Each
 * cap is a multiple of the single legitimate value so forward-compatible
 * optional hints still decode. `keyDecoder: null` opts out of the msgpack
 * library's process-global shared key cache so a hostile peer cannot evict
 * cached keys used by unrelated decoders running in the same process.
 */
const REQUEST_DECODE_OPTIONS = {
  maxMapLength: 16,
  maxArrayLength: 16,
  maxStrLength: MAX_INDEX_NAME_LENGTH,
  maxBinLength: 0,
  maxExtLength: 0,
  keyDecoder: null,
} as const

export type SnapshotSyncHandlerState = SnapshotCacheState

export { DEFAULT_MAX_CONCURRENT_SNAPSHOTS, DEFAULT_MAX_PER_SOURCE_SNAPSHOTS, DEFAULT_MAX_STREAMS_PER_INDEX }

export function createSnapshotSyncHandlerState(
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT_SNAPSHOTS,
  maxPerSource: number = DEFAULT_MAX_PER_SOURCE_SNAPSHOTS,
  maxStreamsPerIndex: number = DEFAULT_MAX_STREAMS_PER_INDEX,
): SnapshotSyncHandlerState {
  return createSnapshotCacheState(maxConcurrent, maxPerSource, maxStreamsPerIndex)
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
    if (message.payload.byteLength > MAX_SNAPSHOT_SYNC_REQUEST_BYTES) {
      respondError(
        sink,
        deps.nodeId,
        message.requestId,
        ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
        `SNAPSHOT_SYNC_REQUEST payload (${message.payload.byteLength} bytes) exceeds the ${MAX_SNAPSHOT_SYNC_REQUEST_BYTES} byte limit`,
      )
      return
    }
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
  const request = decodeRequest(message, sink, deps)
  if (request === null) {
    return
  }

  const sourceIdError = validateSourceId(message.sourceId)
  if (sourceIdError !== null) {
    respondError(sink, deps.nodeId, message.requestId, ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID, sourceIdError)
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

  await acquireAndStream(message, sink, request.indexName, deps)
}

function decodeRequest(
  message: TransportMessage,
  sink: SingleResponseSink,
  deps: SnapshotSyncHandlerDeps,
): SnapshotSyncRequestPayload | null {
  try {
    const decoded = decode(message.payload, REQUEST_DECODE_OPTIONS) as unknown
    return validateSnapshotSyncRequestPayload(decoded)
  } catch (err) {
    const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID
    const errMessage = err instanceof Error ? err.message : String(err)
    respondError(sink, deps.nodeId, message.requestId, code, errMessage)
    return null
  }
}

function validateSourceId(sourceId: unknown): string | null {
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    return 'request sourceId is missing'
  }
  if (sourceId.length > MAX_SOURCE_ID_LENGTH) {
    return `request sourceId exceeds ${MAX_SOURCE_ID_LENGTH} characters`
  }
  if (containsControlCharacter(sourceId)) {
    return 'request sourceId contains control characters'
  }
  return null
}

async function acquireAndStream(
  message: TransportMessage,
  sink: SingleResponseSink,
  indexName: string,
  deps: SnapshotSyncHandlerDeps,
): Promise<void> {
  let sourceHandle: SourceSlotHandle
  try {
    sourceHandle = acquireSourceSlot(deps.state, message.sourceId, indexName)
  } catch (err) {
    const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED
    const errMessage = err instanceof Error ? err.message : String(err)
    respondError(sink, deps.nodeId, message.requestId, code, errMessage)
    return
  }

  try {
    let build: SnapshotBuildResult
    try {
      build = await acquireSnapshotBuild(deps.state, indexName, async () => buildSnapshot(deps, indexName))
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

    let streamHandle: StreamSlotHandle
    try {
      streamHandle = acquireStreamSlot(deps.state, indexName)
    } catch (err) {
      const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED
      const errMessage = err instanceof Error ? err.message : String(err)
      respondError(sink, deps.nodeId, message.requestId, code, errMessage)
      return
    }

    try {
      const metadata = await resolveHeaderMetadata(deps, indexName)
      await streamSnapshotToReplica(sink, deps.nodeId, message.requestId, indexName, build, metadata)
    } finally {
      releaseStreamSlot(deps.state, streamHandle)
    }
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

export type { SingleResponseSink } from './snapshot-stream-writer'

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
