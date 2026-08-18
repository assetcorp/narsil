import { ErrorCodes, NarsilError } from '../../../errors'
import type { RespondFn, SnapshotSyncRequestPayload, TransportMessage } from '../../transport/types'
import { authorizeSnapshotRequest } from '../snapshot-auth'
import {
  createSnapshotCacheState,
  DEFAULT_MAX_CONCURRENT_SNAPSHOTS,
  DEFAULT_MAX_PER_SOURCE_SNAPSHOTS,
  DEFAULT_MAX_STREAMS_PER_INDEX,
} from '../snapshot-cache'
import { createSingleResponseSink, respondError, type SingleResponseSink } from '../snapshot-stream-writer'

import { acquireAndStream } from './stream'
import type { SnapshotSyncHandlerDeps, SnapshotSyncHandlerState, SnapshotSyncStreamOptions } from './types'
import { decodeRequest, MAX_SNAPSHOT_SYNC_REQUEST_BYTES, validateSourceId } from './validation'

export type { SingleResponseSink } from '../snapshot-stream-writer'
export { defaultSnapshotHeaderMetadataProvider } from './metadata'
export type {
  SnapshotHeaderMetadata,
  SnapshotHeaderMetadataProvider,
  SnapshotSyncHandlerDeps,
  SnapshotSyncHandlerState,
  SnapshotSyncStreamOptions,
} from './types'
export { validateSnapshotSyncRequestPayload } from './validation'

export function createSnapshotSyncHandlerState(
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT_SNAPSHOTS,
  maxPerSource: number = DEFAULT_MAX_PER_SOURCE_SNAPSHOTS,
  maxStreamsPerIndex: number = DEFAULT_MAX_STREAMS_PER_INDEX,
): SnapshotSyncHandlerState {
  return createSnapshotCacheState(maxConcurrent, maxPerSource, maxStreamsPerIndex)
}

export async function handleSnapshotSyncRequest(
  message: TransportMessage,
  respond: RespondFn,
  deps: SnapshotSyncHandlerDeps,
): Promise<void> {
  const sink = createSingleResponseSink(respond)
  try {
    if (message.payload.byteLength > MAX_SNAPSHOT_SYNC_REQUEST_BYTES) {
      await respondError(
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
    await respondError(sink, deps.nodeId, message.requestId, code, errMessage)
  }
}

export async function runSnapshotSyncRequest(
  message: TransportMessage,
  sink: SingleResponseSink,
  deps: SnapshotSyncHandlerDeps,
): Promise<void> {
  const request = await decodeRequest(message, sink, deps)
  if (request === null) {
    return
  }

  await streamValidatedSnapshotRequest(message, sink, request, deps)
}

export async function streamValidatedSnapshotRequest(
  message: TransportMessage,
  sink: SingleResponseSink,
  request: SnapshotSyncRequestPayload,
  deps: SnapshotSyncHandlerDeps,
  options: SnapshotSyncStreamOptions = {},
): Promise<void> {
  const sourceIdError = validateSourceId(message.sourceId)
  if (sourceIdError !== null) {
    await respondError(sink, deps.nodeId, message.requestId, ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID, sourceIdError)
    return
  }

  const authResult = await authorizeSnapshotRequest(deps.coordinator, request.indexName, message.sourceId)
  if (authResult.outcome === 'denied') {
    await respondError(sink, deps.nodeId, message.requestId, authResult.code, authResult.reason)
    return
  }

  const existingIndex = deps.engine.listIndexes().find(idx => idx.name === request.indexName)
  if (existingIndex === undefined) {
    await respondError(
      sink,
      deps.nodeId,
      message.requestId,
      ErrorCodes.SNAPSHOT_SYNC_INDEX_NOT_FOUND,
      `Index '${request.indexName}' is not hosted on this node`,
    )
    return
  }

  await acquireAndStream(message, sink, request, deps, options)
}
