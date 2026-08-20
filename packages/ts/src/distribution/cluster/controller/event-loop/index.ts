import type { ClusterCoordinator, NodeEvent, SchemaEvent } from '../../../coordinator/types'
import type { NodeTransport, RespondFn, TransportMessage } from '../../../transport/types'
import { ClusterMessageTypes, ReplicationMessageTypes } from '../../../transport/types'
import { handleSchemaEvent, scheduleDebouncedAllocation } from './allocation'
import { handleInsyncAddMessage, handleInsyncRemoveMessage, handleQueuedBootstrapComplete } from './insync-messages'
import { clearEventLoopWatchers, type EventLoopState } from './state'

export { clearEventLoopWatchers, createEventLoopState, type EventLoopState } from './state'

export async function startEventLoop(
  state: EventLoopState,
  coordinator: ClusterCoordinator,
  transport: NodeTransport,
  nodeId: string,
  isActive: () => boolean,
  onError?: (indexName: string, error: unknown) => void,
): Promise<void> {
  clearEventLoopWatchers(state)

  const unwatchNodes = await coordinator.watchNodes((_event: NodeEvent) => {
    scheduleDebouncedAllocation(state, coordinator, isActive, onError)
  })
  state.unwatchNodes = unwatchNodes

  const unwatchSchemas = await coordinator.watchSchemas((event: SchemaEvent) => {
    handleSchemaEvent(event, coordinator, state.knownIndexes, isActive).catch(() => {
      /* Schema event handling failure is recoverable; the next event retries. */
    })
  })
  state.unwatchSchemas = unwatchSchemas

  const unwatchTransport = await transport.listen((message: TransportMessage, respond: RespondFn) => {
    if (!isActive()) {
      return
    }
    if (message.type === ReplicationMessageTypes.INSYNC_REMOVE) {
      handleInsyncRemoveMessage(state, message, respond, coordinator, nodeId)
    } else if (message.type === ReplicationMessageTypes.INSYNC_ADD) {
      handleInsyncAddMessage(state, message, respond, coordinator, nodeId)
    } else if (message.type === ClusterMessageTypes.BOOTSTRAP_COMPLETE) {
      handleQueuedBootstrapComplete(state, message, respond, coordinator, nodeId)
    }
  })
  state.unwatchTransport = unwatchTransport

  scheduleDebouncedAllocation(state, coordinator, isActive, onError)
}
