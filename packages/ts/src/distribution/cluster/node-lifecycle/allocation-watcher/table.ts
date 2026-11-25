import type { AllocationTable, PartitionAssignment } from '../../../coordinator/types'
import { holdsLastCopy } from '../../last-holders'
import { abortBootstrapState } from '../bootstrap'
import type { NodeLifecycleConfig } from '../types'
import { startBootstrap } from './bootstrap-restart'
import { type AllocationWatcherState, forgetAwaitedAdmission, partitionKey, type TrackedPartition } from './state'

export function processAllocationChange(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  table: AllocationTable,
): void {
  if (state.stopped) {
    return
  }
  releaseEarlierIndex(state, config, table)

  const nodeId = config.registration.nodeId
  const currentKeys = new Set<string>()
  seedRetainedFromRecord(state, config, table.indexName)

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
      inSync: assignment.inSyncSet.includes(nodeId),
    })

    if (servesPartition(assignment, nodeId)) {
      state.pendingPartitions.delete(key)
    } else {
      state.pendingPartitions.add(key)
    }

    if (config.onHoldPartition !== undefined && alreadyHoldsData(assignment, nodeId)) {
      config.onHoldPartition(table.indexName, partitionId)
    }

    if (isPrimary && assignment.state === 'ACTIVE') {
      config.onLeadingTerm?.(table.indexName, partitionId, assignment)
    }
  }

  removeDroppedPartitions(state, config, table, currentKeys)
  releaseSupersededCopies(state, config, table, currentKeys)
}

function releaseEarlierIndex(state: AllocationWatcherState, config: NodeLifecycleConfig, table: AllocationTable): void {
  if (table.indexUuid === undefined) {
    return
  }
  const known = state.indexUuids.get(table.indexName)
  state.indexUuids.set(table.indexName, table.indexUuid)
  if (known === undefined || known === table.indexUuid) {
    return
  }
  processAllocationChange(state, config, {
    indexName: table.indexName,
    version: table.version,
    replicationFactor: table.replicationFactor,
    assignments: new Map(),
  })
  config.onIndexTornDown?.(table.indexName)
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

function servesPartition(assignment: PartitionAssignment, nodeId: string): boolean {
  if (assignment.state === 'INITIALISING' || assignment.state === 'UNASSIGNED') {
    return false
  }
  return assignment.primary === nodeId || assignment.inSyncSet.includes(nodeId)
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

function abortActiveBootstrap(state: AllocationWatcherState, key: string): void {
  const active = state.activeBootstraps.get(key)
  if (active !== undefined) {
    abortBootstrapState(active)
    state.activeBootstraps.delete(key)
  }
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
      startBootstrap(state, config, indexName, partitionId, nodeId, assignment.primaryTerm)
    }
    return
  }

  startBootstrap(state, config, indexName, partitionId, assignment.primary, assignment.primaryTerm)
}

function handleExistingAssignment(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  existing: TrackedPartition,
  assignment: PartitionAssignment,
  nodeId: string,
): void {
  const { indexName, partitionId } = existing
  settleAwaitedAdmission(state, partitionKey(indexName, partitionId), assignment, nodeId)

  if (existing.isPrimary && assignment.primary !== nodeId && assignment.primaryTerm > existing.primaryTerm) {
    abortActiveBootstrap(state, partitionKey(indexName, partitionId))
    if (assignment.primary !== null) {
      config.onPrimaryDemotion?.(indexName, partitionId, assignment.primary)
      if (!alreadyHoldsData(assignment, nodeId)) {
        startBootstrap(state, config, indexName, partitionId, assignment.primary, assignment.primaryTerm)
      }
    }
    return
  }

  if (promotedBackAtHigherTerm(existing, assignment, nodeId)) {
    startBootstrap(state, config, indexName, partitionId, nodeId, assignment.primaryTerm)
    return
  }

  if (assignment.primary !== null && replicaNeedsResync(state, existing, assignment, nodeId)) {
    startBootstrap(state, config, indexName, partitionId, assignment.primary, assignment.primaryTerm)
  }
}

function settleAwaitedAdmission(
  state: AllocationWatcherState,
  key: string,
  assignment: PartitionAssignment,
  nodeId: string,
): void {
  const awaited = state.awaitedAdmissions.get(key)
  if (awaited === undefined) {
    return
  }
  const stillAwaited =
    assignment.primary === awaited.primaryNodeId &&
    assignment.primaryTerm === awaited.primaryTerm &&
    assignment.replicas.includes(nodeId) &&
    !assignment.inSyncSet.includes(nodeId)
  if (!stillAwaited) {
    forgetAwaitedAdmission(state, key)
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
  const key = partitionKey(existing.indexName, existing.partitionId)
  return !state.activeBootstraps.has(key) && !state.awaitedAdmissions.has(key)
}

function promotedBackAtHigherTerm(
  existing: TrackedPartition,
  assignment: PartitionAssignment,
  nodeId: string,
): boolean {
  return (
    assignment.primary === nodeId &&
    assignment.state === 'INITIALISING' &&
    assignment.primaryTerm > existing.primaryTerm
  )
}

function keepsCopyForRecovery(table: AllocationTable, partitionId: number, nodeId: string): boolean {
  const assignment = table.assignments.get(partitionId)
  if (assignment === undefined) {
    return false
  }
  return holdsLastCopy(assignment, nodeId)
}

function seedRetainedFromRecord(state: AllocationWatcherState, config: NodeLifecycleConfig, indexName: string): void {
  if (config.retainedPartitionIds === undefined || state.indexesSeededFromRecord.has(indexName)) {
    return
  }
  state.indexesSeededFromRecord.add(indexName)
  for (const partitionId of config.retainedPartitionIds(indexName)) {
    state.retainedPartitions.add(partitionKey(indexName, partitionId))
  }
}

function retainedPartitionIdOf(key: string, indexName: string): number | null {
  if (!key.startsWith(`${indexName}:`)) {
    return null
  }
  const partitionId = Number(key.slice(indexName.length + 1))
  return Number.isInteger(partitionId) ? partitionId : null
}

function copyHasNoFurtherUse(table: AllocationTable, partitionId: number, nodeId: string): boolean {
  if (table.assignments.size === 0) {
    return true
  }
  const assignment = table.assignments.get(partitionId)
  if (assignment === undefined) {
    return false
  }
  return assignment.state === 'ACTIVE' && assignment.primary !== null && assignment.primary !== nodeId
}

function releaseSupersededCopies(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  table: AllocationTable,
  currentKeys: Set<string>,
): void {
  const nodeId = config.registration.nodeId
  for (const key of [...state.retainedPartitions]) {
    const partitionId = retainedPartitionIdOf(key, table.indexName)
    if (partitionId === null) {
      continue
    }
    if (currentKeys.has(key)) {
      state.retainedPartitions.delete(key)
      continue
    }
    if (!copyHasNoFurtherUse(table, partitionId, nodeId)) {
      continue
    }
    state.retainedPartitions.delete(key)
    forgetAwaitedAdmission(state, key)
    if (config.onRemovePartition !== undefined) {
      config.onRemovePartition(table.indexName, partitionId)
    }
  }
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
    state.pendingPartitions.delete(key)
    forgetAwaitedAdmission(state, key)

    abortActiveBootstrap(state, key)

    if (keepsCopyForRecovery(table, tracked.partitionId, config.registration.nodeId)) {
      state.retainedPartitions.add(key)
      continue
    }

    state.retainedPartitions.delete(key)
    if (config.onRemovePartition !== undefined) {
      config.onRemovePartition(tracked.indexName, tracked.partitionId)
    }
  }
}
