import { isSyncEpoch, newSyncEpoch } from '#platform/optional-writes-host'
import type { IndexMetadata } from '../types/internal'
import type { IndexChangesState, IndexSyncState } from './registry-entry'

export interface IndexEpochStates {
  sync: IndexSyncState | null
  changes: IndexChangesState | null
}

export function epochStatesOfMetadata(metadata: IndexMetadata): IndexEpochStates {
  const syncOn = metadata.sync?.enabled === true
  const changesOn = metadata.changes?.enabled === true
  if (!syncOn && !changesOn) return { sync: null, changes: null }
  const stored = isSyncEpoch(metadata.syncEpoch) ? metadata.syncEpoch : null
  const epoch = stored ?? newSyncEpoch()
  const sync = metadata.sync
  const changes = metadata.changes
  return {
    sync:
      syncOn && sync !== undefined
        ? {
            ...(sync.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: sync.historyMaxAgeMs } : {}),
            ...(sync.historyMaxBytes !== undefined ? { historyMaxBytes: sync.historyMaxBytes } : {}),
            active: stored !== null && metadata.syncActive === true,
            epoch,
          }
        : null,
    changes:
      changesOn && changes !== undefined
        ? {
            previousDocument: changes.previousDocument === true,
            ...(changes.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: changes.historyMaxAgeMs } : {}),
            ...(changes.historyMaxBytes !== undefined ? { historyMaxBytes: changes.historyMaxBytes } : {}),
            epoch,
          }
        : null,
  }
}

export function indexEpochOf(states: IndexEpochStates): string | null {
  return states.sync?.epoch ?? states.changes?.epoch ?? null
}
