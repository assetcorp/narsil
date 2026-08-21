import type { AllocationTable } from '../../coordinator/types'
import { type AllocationWatcherState, processInitialAllocations, startAllocationWatcher } from './allocation-watcher'
import { type RegistrationHeartbeatState, startRegistrationHeartbeat } from './heartbeat'
import type { NodeLifecycleConfig } from './types'

/**
 * Joins this node to the cluster, and returns once it is registered and following its partitions.
 *
 * The node registers itself, starts the heartbeat that keeps the registration alive, bootstraps every partition the
 * allocation tables already assign to it, and then follows the allocation table for further changes. A failure at any step reaches the
 * caller, which stops the heartbeat before it reports the node stopped.
 *
 * @param config - The lifecycle configuration, which names the coordinator, the transport, and this node.
 * @param watcherState - The allocation watcher state this call registers the watcher on.
 * @param heartbeatState - The heartbeat state this call starts the renewal timer on.
 * @returns A promise that settles once the node has joined.
 */
export async function joinCluster(
  config: NodeLifecycleConfig,
  watcherState: AllocationWatcherState,
  heartbeatState: RegistrationHeartbeatState,
): Promise<void> {
  await config.coordinator.registerNode(config.registration)

  startRegistrationHeartbeat(heartbeatState, config)

  const initialTables = await loadInitialAllocations(config)

  processInitialAllocations(watcherState, config, initialTables)

  await startAllocationWatcher(watcherState, config)
}

async function loadInitialAllocations(config: NodeLifecycleConfig): Promise<AllocationTable[]> {
  const tables: AllocationTable[] = []

  for (const indexName of config.knownIndexNames) {
    const table = await config.coordinator.getAllocation(indexName)
    if (table !== null) {
      tables.push(table)
    }
  }

  return tables
}

/**
 * Removes this node's registration from the coordinator, so that the controller reallocates its partitions.
 *
 * A caller stops the registration heartbeat and waits for the renewal in flight before it calls this, because a
 * renewal that lands afterwards would write the registration back.
 *
 * @param config - The lifecycle configuration, which names the coordinator and this node.
 * @returns A promise that settles once the coordinator has dropped the registration.
 */
export async function leaveCluster(config: NodeLifecycleConfig): Promise<void> {
  await config.coordinator.deregisterNode(config.registration.nodeId)
}
