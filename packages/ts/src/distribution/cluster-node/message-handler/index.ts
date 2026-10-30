import type { RespondFn, TransportMessage } from '../../transport/types'
import { ClusterMessageTypes, QueryMessageTypes, ReplicationMessageTypes } from '../../transport/types'
import { encodeErrorReplyFrom } from '../error-reply'
import { handleRebuildAnalysis } from '../rebuild-analysis'
import { handleReshardCutover, handleReshardForward, handleReshardPurge, handleReshardStart } from '../reshard/handlers'
import { handleIndexSettings } from './index-settings'
import { handlePartitionStores } from './partition-stores'
import { handleFetch, handleSearch, handleStats } from './queries'
import { handleCount, handleList, handlePreflight, handleSuggest } from './read-handlers'
import { handleSyncRequestMessage } from './sync'
import type { DataNodeHandlerDeps, TransportHandler } from './types'
import { handleForward, handleForwardBatch, handleReplicationEntry, handleReplicationEntryBatch } from './writes'

export { handlePartitionStores } from './partition-stores'
export type { DataNodeHandlerDeps, TransportHandler } from './types'
export { validateForwardPayload } from './writes'

export function createDataNodeHandler(deps: DataNodeHandlerDeps): TransportHandler {
  return async (message: TransportMessage, respond: RespondFn): Promise<void> => {
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
        case ClusterMessageTypes.PARTITION_STORES:
          await handlePartitionStores(message, respond, deps)
          return
        case ClusterMessageTypes.REBUILD_ANALYSIS:
          await handleRebuildAnalysis(message, respond, deps)
          return
        case ClusterMessageTypes.RESHARD_START:
          await handleReshardStart(message, respond, deps)
          return
        case ClusterMessageTypes.RESHARD_FORWARD:
          await handleReshardForward(message, respond, deps)
          return
        case ClusterMessageTypes.RESHARD_CUTOVER:
          await handleReshardCutover(message, respond, deps)
          return
        case ClusterMessageTypes.RESHARD_PURGE:
          await handleReshardPurge(message, respond, deps)
          return
        case ClusterMessageTypes.INDEX_SETTINGS:
          await handleIndexSettings(message, respond, deps)
          return
        default:
          return
      }
    } catch (err) {
      const errorPayload = encodeErrorReplyFrom(err, 'INTERNAL_ERROR')
      await respond({
        type: `${message.type}.error`,
        sourceId: deps.nodeId,
        requestId: message.requestId,
        payload: errorPayload,
      })
    }
  }
}
