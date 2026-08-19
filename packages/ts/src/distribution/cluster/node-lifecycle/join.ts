import type { AllocationTable } from '../../coordinator/types'
import { type AllocationWatcherState, processInitialAllocations, startAllocationWatcher } from './allocation-watcher'
import { type RegistrationHeartbeatState, startRegistrationHeartbeat } from './heartbeat'
import type { NodeLifecycleConfig } from './types'

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

export async function leaveCluster(config: NodeLifecycleConfig): Promise<void> {
  await config.coordinator.deregisterNode(config.registration.nodeId)
}
