import type { AllocationEvent, AllocationTable } from '../../../coordinator/types'
import { belongsToAnotherIndex } from '../../table-identity'
import type { NodeLifecycleConfig } from '../types'
import type { AllocationWatcherState } from './state'
import { processAllocationChange } from './table'

export type { AllocationWatcherState } from './state'
export { createAllocationWatcherState, stopAllocationWatcher } from './state'
export { processInitialAllocations } from './table'

/**
 * Starts following the allocation table, so that this node bootstraps every partition the controller gives it.
 *
 * A burst of allocation changes collapses into one pass over the table, because each event replaces the timer the
 * previous one set. A table whose version does not rise above the pending one, or whose index uuid differs from the
 * pending table's, comes from an index that was dropped and created again under the same name, so the watcher first
 * processes the pending table of the dropped index, which releases every partition that the dropped index held on
 * this node.
 *
 * @param state - The watcher state this call registers the watcher on.
 * @param config - The lifecycle configuration, which names the coordinator and the debounce window.
 * @returns A promise that settles once the coordinator has registered the watcher.
 */
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
  const pending = state.pendingTables.get(table.indexName)
  if (pending !== undefined && (table.version <= pending.version || belongsToAnotherIndex(pending, table.indexUuid))) {
    state.pendingTables.delete(table.indexName)
    processAllocationChange(state, config, pending)
    if (pending.assignments.size === 0) config.onIndexTornDown?.(pending.indexName)
  }
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
      if (pending.assignments.size === 0) config.onIndexTornDown?.(pending.indexName)
    }
  }, config.allocationDebounceMs)
}
