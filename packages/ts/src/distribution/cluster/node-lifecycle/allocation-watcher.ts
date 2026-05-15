import type { AllocationEvent, AllocationTable, PartitionAssignment } from '../../coordinator/types'
import { abortBootstrapState, bootstrapPartition, createBootstrapState } from './bootstrap'
import type { NodeLifecycleConfig, PartitionBootstrapState } from './types'

export interface AllocationWatcherState {
  unwatchAllocation: (() => void) | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  activeBootstraps: Map<string, PartitionBootstrapState>
  trackedPartitions: Map<string, TrackedPartition>
  pendingTables: Map<string, AllocationTable>
  stopped: boolean
}

interface TrackedPartition {
  indexName: string
  partitionId: number
  isPrimary: boolean
  primaryNodeId: string | null
  primaryTerm: number
}

function partitionKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
}

export function createAllocationWatcherState(): AllocationWatcherState {
  return {
    unwatchAllocation: null,
    debounceTimer: null,
    activeBootstraps: new Map(),
    trackedPartitions: new Map(),
    pendingTables: new Map(),
    stopped: false,
  }
}

export async function startAllocationWatcher(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
): Promise<void> {
  const unwatchAllocation = await config.coordinator.watchAllocation((event: AllocationEvent) => {
    if (state.stopped) {
      return
    }
    scheduleProcessAllocation(state, config, event.table)
  })
  state.unwatchAllocation = unwatchAllocation
}

function scheduleProcessAllocation(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  table: AllocationTable,
): void {
  state.pendingTables.set(table.indexName, table)

  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer)
  }

  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null
    const tablesToProcess = Array.from(state.pendingTables.values())
    state.pendingTables.clear()
    for (const pending of tablesToProcess) {
      processAllocationChange(state, config, pending)
    }
  }, config.allocationDebounceMs)
}

function processAllocationChange(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  table: AllocationTable,
): void {
  if (state.stopped) {
    return
  }

  const nodeId = config.registration.nodeId
  const currentKeys = new Set<string>()

  for (const [partitionId, assignment] of table.assignments) {
    if (!isNodeAssigned(assignment, nodeId)) {
      continue
    }

    const key = partitionKey(table.indexName, partitionId)
    currentKeys.add(key)
    const existing = state.trackedPartitions.get(key)
    const isPrimary = assignment.primary === nodeId

    if (existing === undefined) {
      handleNewAssignment(state, config, table.indexName, partitionId, assignment, nodeId)
    } else {
      handleExistingAssignment(state, config, existing, assignment, nodeId)
    }

    state.trackedPartitions.set(key, {
      indexName: table.indexName,
      partitionId,
      isPrimary,
      primaryNodeId: assignment.primary,
      primaryTerm: assignment.primaryTerm,
    })
  }

  removeUnassignedPartitions(state, config, table.indexName, currentKeys)
}

function isNodeAssigned(assignment: PartitionAssignment, nodeId: string): boolean {
  if (assignment.primary === nodeId) {
    return true
  }
  return assignment.replicas.includes(nodeId)
}

function handleNewAssignment(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  nodeId: string,
): void {
  if (assignment.state === 'ACTIVE' && assignment.primary === nodeId) {
    return
  }

  if (assignment.primary === null) {
    return
  }

  if (assignment.primary === nodeId) {
    return
  }

  startBootstrap(state, config, indexName, partitionId, assignment.primary)
}

function handleExistingAssignment(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  existing: TrackedPartition,
  assignment: PartitionAssignment,
  nodeId: string,
): void {
  if (existing.isPrimary && assignment.primary !== nodeId && assignment.primaryTerm > existing.primaryTerm) {
    if (assignment.primary !== null) {
      if (config.onPrimaryDemotion !== undefined) {
        config.onPrimaryDemotion(existing.indexName, existing.partitionId, assignment.primary)
      }

      startBootstrap(state, config, existing.indexName, existing.partitionId, assignment.primary)
    }
  }
}

function startBootstrap(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
): void {
  const key = partitionKey(indexName, partitionId)
  const existingBootstrap = state.activeBootstraps.get(key)
  if (existingBootstrap !== undefined) {
    abortBootstrapState(existingBootstrap)
  }

  const bootstrapState = createBootstrapState(indexName, partitionId, primaryNodeId)
  state.activeBootstraps.set(key, bootstrapState)

  bootstrapPartition(
    bootstrapState,
    config.coordinator,
    config.transport,
    config.registration.nodeId,
    config.bootstrapRetryBaseMs,
    config.bootstrapRetryMaxMs,
    config.bootstrapMaxRetries,
    config.onBootstrapPartition,
    config.onError,
  )
    .then(succeeded => {
      if (state.activeBootstraps.get(key) === bootstrapState) {
        state.activeBootstraps.delete(key)
      }
      if (!succeeded) {
        state.trackedPartitions.delete(key)
      }
    })
    .catch(() => {
      if (state.activeBootstraps.get(key) === bootstrapState) {
        state.activeBootstraps.delete(key)
      }
      state.trackedPartitions.delete(key)
    })
}

function removeUnassignedPartitions(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  indexName: string,
  currentKeys: Set<string>,
): void {
  for (const [key, tracked] of state.trackedPartitions) {
    if (tracked.indexName !== indexName) {
      continue
    }
    if (currentKeys.has(key)) {
      continue
    }

    state.trackedPartitions.delete(key)

    const activeBootstrap = state.activeBootstraps.get(key)
    if (activeBootstrap !== undefined) {
      abortBootstrapState(activeBootstrap)
      state.activeBootstraps.delete(key)
    }

    if (config.onRemovePartition !== undefined) {
      config.onRemovePartition(tracked.indexName, tracked.partitionId)
    }
  }
}

export function stopAllocationWatcher(state: AllocationWatcherState): void {
  state.stopped = true

  if (state.unwatchAllocation !== null) {
    state.unwatchAllocation()
    state.unwatchAllocation = null
  }

  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }

  for (const bootstrapState of state.activeBootstraps.values()) {
    abortBootstrapState(bootstrapState)
  }
  state.activeBootstraps.clear()
  state.trackedPartitions.clear()
  state.pendingTables.clear()
}

export function processInitialAllocations(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  tables: AllocationTable[],
): void {
  for (const table of tables) {
    processAllocationChange(state, config, table)
  }
}
