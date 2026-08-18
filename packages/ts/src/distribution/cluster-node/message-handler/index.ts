import { encode } from '@msgpack/msgpack'
import { NarsilError } from '../../../errors'
import type { TransportMessage } from '../../transport/types'
import { QueryMessageTypes, ReplicationMessageTypes } from '../../transport/types'
import { handleSnapshotSyncRequest } from '../snapshot-sync-handler'
import { handleFetch, handleSearch, handleStats } from './queries'
import { handleCount, handleList, handlePreflight, handleSuggest } from './read-handlers'
import { handleSyncRequestMessage } from './sync'
import type { DataNodeHandlerDeps, TransportHandler } from './types'
import { handleForward, handleForwardBatch, handleReplicationEntry, handleReplicationEntryBatch } from './writes'

export type { DataNodeHandlerDeps, TransportHandler } from './types'
export { validateForwardPayload } from './writes'

export function createDataNodeHandler(deps: DataNodeHandlerDeps): TransportHandler {
  return async (message: TransportMessage, respond: (response: TransportMessage) => void): Promise<void> => {
    if (message.type === ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST) {
      await handleSnapshotSyncRequest(message, respond, {
        nodeId: deps.nodeId,
        engine: deps.engine,
        coordinator: deps.coordinator,
        state: deps.snapshotSyncState,
        resolveHeaderMetadata: deps.resolveHeaderMetadata,
      })
      return
    }

    try {
      switch (message.type) {
        case ReplicationMessageTypes.SYNC_REQUEST:
          await handleSyncRequestMessage(message, respond, deps)
          return
        case ReplicationMessageTypes.FORWARD:
          await handleForward(message, respond, deps)
          return
        case ReplicationMessageTypes.FORWARD_BATCH:
          await handleForwardBatch(message, respond, deps)
          return
        case ReplicationMessageTypes.ENTRY:
          await handleReplicationEntry(message, respond, deps)
          return
        case ReplicationMessageTypes.ENTRY_BATCH:
          await handleReplicationEntryBatch(message, respond, deps)
          return
        case QueryMessageTypes.SEARCH:
          await handleSearch(message, respond, deps)
          return
        case QueryMessageTypes.FETCH:
          await handleFetch(message, respond, deps)
          return
        case QueryMessageTypes.STATS:
          await handleStats(message, respond, deps)
          return
        case QueryMessageTypes.COUNT:
          await handleCount(message, respond, deps)
          return
        case QueryMessageTypes.LIST:
          await handleList(message, respond, deps)
          return
        case QueryMessageTypes.SUGGEST:
          await handleSuggest(message, respond, deps)
          return
        case QueryMessageTypes.PREFLIGHT:
          await handlePreflight(message, respond, deps)
          return
        default:
          return
      }
    } catch (err) {
      const errorPayload = encode({
        error: true,
        code: err instanceof NarsilError ? err.code : 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      })
      respond({
        type: `${message.type}.error`,
        sourceId: deps.nodeId,
        requestId: message.requestId,
        payload: errorPayload,
      })
    }
  }
}
