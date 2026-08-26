import type { AllocationTable } from '../../../coordinator/types'
import { abortBootstrapState } from '../bootstrap'
import type { PartitionBootstrapState } from '../types'

export interface AllocationWatcherState {
  unwatchAllocation: (() => void) | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  activeBootstraps: Map<string, PartitionBootstrapState>
  trackedPartitions: Map<string, TrackedPartition>
  pendingTables: Map<string, AllocationTable>
  restartWaiters: Map<ReturnType<typeof setTimeout>, () => void>
  stopped: boolean
}

export interface TrackedPartition {
  indexName: string
  partitionId: number
  isPrimary: boolean
  primaryNodeId: string | null
  primaryTerm: number
}

export function partitionKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
}

/**
 * Builds the state a data node keeps while it follows the allocation table, which starts with no watcher, no
 * tracked partition, and no bootstrap running.
 *
 * @returns The fresh state, ready for {@link startAllocationWatcher}.
 */
export function createAllocationWatcherState(): AllocationWatcherState {
  return {
    unwatchAllocation: null,
    debounceTimer: null,
    activeBootstraps: new Map(),
    trackedPartitions: new Map(),
    pendingTables: new Map(),
    restartWaiters: new Map(),
    stopped: false,
  }
}

/**
 * Stops following the allocation table and abandons every bootstrap in progress.
 *
 * The state keeps its `stopped` flag afterwards, so a callback that was already in flight does nothing when it
 * resumes. A node that rejoins the cluster builds fresh state rather than reusing this one.
 *
 * @param state - The watcher state to stop.
 */
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

  for (const [timer, resolve] of state.restartWaiters) {
    clearTimeout(timer)
    resolve()
  }
  state.restartWaiters.clear()

  for (const bootstrapState of state.activeBootstraps.values()) {
    abortBootstrapState(bootstrapState)
  }
  state.activeBootstraps.clear()
  state.trackedPartitions.clear()
  state.pendingTables.clear()
}
