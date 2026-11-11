import type { SyncStatus } from '../../types/sync'
import type { IndexSyncState } from '../registry-entry'

export function syncStatusOf(sync: IndexSyncState | null): SyncStatus {
  if (sync === null) return { enabled: false, active: false, epoch: null }
  return {
    enabled: true,
    ...(sync.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: sync.historyMaxAgeMs } : {}),
    ...(sync.historyMaxBytes !== undefined ? { historyMaxBytes: sync.historyMaxBytes } : {}),
    active: sync.active,
    epoch: sync.epoch,
  }
}
