import type { AllocationTable, PartitionAssignment } from '../../../coordinator/types'
import { abortBootstrapState } from '../bootstrap'
import type { NodeLifecycleConfig } from '../types'
import { startBootstrap } from './bootstrap-restart'
import { type AllocationWatcherState, partitionKey, type TrackedPartition } from './state'

export function processAllocationChange(
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

    if (config.onHoldPartition !== undefined && alreadyHoldsData(assignment, nodeId)) {
      config.onHoldPartition(table.indexName, partitionId)
    }
  }

  removeDroppedPartitions(state, config, table, currentKeys)
}

/**
 * Bootstraps the partitions this node already holds, from the allocation tables it read when it joined.
 *
 * A node calls this before it starts watching, so that it acts on the tables that stood at join time rather than
 * waiting for the next change to any of them.
 *
 * @param state - The watcher state that tracks the partitions.
 * @param config - The lifecycle configuration, which names this node and the work each bootstrap runs.
 * @param tables - The allocation tables the node read when it joined.
 */
export function processInitialAllocations(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  tables: AllocationTable[],
): void {
  for (const table of tables) {
    processAllocationChange(state, config, table)
  }
}

function alreadyHoldsData(assignment: PartitionAssignment, nodeId: string): boolean {
  if (assignment.state !== 'ACTIVE') {
    return false
  }
  return assignment.primary === nodeId || assignment.inSyncSet.includes(nodeId)
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
    if (assignment.state === 'INITIALISING') {
      startBootstrap(state, config, indexName, partitionId, nodeId)
    }
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
    return
  }

  if (assignment.primary !== null && replicaNeedsResync(state, existing, assignment, nodeId)) {
    startBootstrap(state, config, existing.indexName, existing.partitionId, assignment.primary)
  }
}

function replicaNeedsResync(
  state: AllocationWatcherState,
  existing: TrackedPartition,
  assignment: PartitionAssignment,
  nodeId: string,
): boolean {
  if (assignment.state !== 'ACTIVE') {
    return false
  }
  if (assignment.primary === null || assignment.primary === nodeId) {
    return false
  }
  if (!assignment.replicas.includes(nodeId)) {
    return false
  }
  if (assignment.inSyncSet.includes(nodeId)) {
    return false
  }
  return !state.activeBootstraps.has(partitionKey(existing.indexName, existing.partitionId))
}

function keepsCopyForRecovery(table: AllocationTable, tracked: TrackedPartition, nodeId: string): boolean {
  const assignment = table.assignments.get(tracked.partitionId)
  if (assignment === undefined || assignment.state !== 'UNASSIGNED') {
    return false
  }
  return assignment.inSyncSet.includes(nodeId)
}

function removeDroppedPartitions(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  table: AllocationTable,
  currentKeys: Set<string>,
): void {
  for (const [key, tracked] of state.trackedPartitions) {
    if (tracked.indexName !== table.indexName) {
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

    if (keepsCopyForRecovery(table, tracked, config.registration.nodeId)) {
      continue
    }

    if (config.onRemovePartition !== undefined) {
      config.onRemovePartition(tracked.indexName, tracked.partitionId)
    }
  }
}
