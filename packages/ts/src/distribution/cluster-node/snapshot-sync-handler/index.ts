import { ErrorCodes } from '../../../errors'
import type { TransportMessage } from '../../transport/types'
import { authorizeSnapshotRequest } from '../snapshot-auth'
import { createSnapshotCacheState } from '../snapshot-cache'
import { respondError, type SingleResponseSink } from '../snapshot-stream-writer'

import { acquireAndStream } from './stream'
import type { SnapshotSyncHandlerDeps, SnapshotSyncHandlerState, SnapshotSyncStreamOptions } from './types'
import { validateSourceId } from './validation'

export type { SingleResponseSink } from '../snapshot-stream-writer'
export type { SnapshotSyncHandlerDeps, SnapshotSyncHandlerState, SnapshotSyncStreamOptions } from './types'

export function createSnapshotSyncHandlerState(): SnapshotSyncHandlerState {
  return createSnapshotCacheState()
}

export async function streamValidatedSnapshotRequest(
  message: TransportMessage,
  sink: SingleResponseSink,
  indexName: string,
  deps: SnapshotSyncHandlerDeps,
  options: SnapshotSyncStreamOptions,
): Promise<void> {
  const sourceIdError = validateSourceId(message.sourceId)
  if (sourceIdError !== null) {
    await respondError(sink, deps.nodeId, message, ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID, sourceIdError)
    return
  }

  const authResult = await authorizeSnapshotRequest(deps.coordinator, indexName, message.sourceId)
  if (authResult.outcome === 'denied') {
    await respondError(sink, deps.nodeId, message, authResult.code, authResult.reason)
    return
  }

  const existingIndex = deps.engine.listIndexes().find(idx => idx.name === indexName)
  if (existingIndex === undefined) {
    await respondError(
      sink,
      deps.nodeId,
      message,
      ErrorCodes.SNAPSHOT_SYNC_INDEX_NOT_FOUND,
      `Index '${indexName}' is not hosted on this node`,
    )
    return
  }

  await acquireAndStream(message, sink, indexName, deps, options)
}
