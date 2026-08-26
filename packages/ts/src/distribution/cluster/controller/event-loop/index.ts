import type { ClusterCoordinator, NodeEvent, SchemaEvent } from '../../../coordinator/types'
import type { NodeTransport, RespondFn, TransportMessage } from '../../../transport/types'
import { ClusterMessageTypes, ReplicationMessageTypes } from '../../../transport/types'
import { handleSchemaEvent, scheduleDebouncedAllocation } from './allocation'
import { handleInsyncAddMessage, handleInsyncRemoveMessage, handleQueuedBootstrapComplete } from './insync-messages'
import { clearEventLoopWatchers, type EventLoopState } from './state'

export { clearEventLoopWatchers, createEventLoopState, type EventLoopState } from './state'

/**
 * Starts the work an active controller does, which is to watch the cluster for change and to answer the messages a
 * primary sends it.
 *
 * The controller registers a watcher on node registrations and another on schemas, listens for in-sync and bootstrap
 * messages, and runs the allocator once for every index it starts with. A failure at any of those steps drops the watchers this call had
 * already registered, before the error reaches the caller, so that a controller which failed to start leaves
 * nothing running behind it.
 *
 * @param state - The event loop state that holds the watchers, the debounce timer, and the in-sync queue.
 * @param coordinator - The cluster coordinator this controller reads the topology from and writes allocations to.
 * @param transport - The node transport that delivers messages from the data nodes.
 * @param nodeId - The controller's own node id, which names the sender of every response.
 * @param isActive - Reports whether this node still holds the controller lease.
 * @param onError - Called with the index name and the error whenever an allocation run fails.
 * @returns A promise that settles once every watcher is registered.
 */
export async function startEventLoop(
  state: EventLoopState,
  coordinator: ClusterCoordinator,
  transport: NodeTransport,
  nodeId: string,
  isActive: () => boolean,
  onError?: (indexName: string, error: unknown) => void,
): Promise<void> {
  clearEventLoopWatchers(state)
  state.transport = transport
  state.controllerNodeId = nodeId

  try {
    state.unwatchNodes = await coordinator.watchNodes((_event: NodeEvent) => {
      scheduleDebouncedAllocation(state, coordinator, isActive, onError)
    })

    state.unwatchSchemas = await coordinator.watchSchemas((event: SchemaEvent) => {
      handleSchemaEvent(event, coordinator, state, isActive, onError).catch(error => {
        if (onError !== undefined) {
          onError(event.indexName, error)
        }
      })
    })

    state.unwatchTransport = await transport.listen((message: TransportMessage, respond: RespondFn) => {
      if (!isActive()) {
        return
      }
      if (message.type === ReplicationMessageTypes.INSYNC_REMOVE) {
        handleInsyncRemoveMessage(state, message, respond, coordinator, nodeId, isActive)
      } else if (message.type === ReplicationMessageTypes.INSYNC_ADD) {
        handleInsyncAddMessage(state, message, respond, coordinator, nodeId, isActive, onError)
      } else if (message.type === ClusterMessageTypes.BOOTSTRAP_COMPLETE) {
        handleQueuedBootstrapComplete(state, message, respond, coordinator, nodeId, isActive)
      }
    })
  } catch (error) {
    clearEventLoopWatchers(state)
    throw error
  }

  scheduleDebouncedAllocation(state, coordinator, isActive, onError)
}
