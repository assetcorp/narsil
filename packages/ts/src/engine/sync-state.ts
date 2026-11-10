import { isSyncEpoch, newSyncEpoch } from '#platform/optional-writes-host'
import type { IndexMetadata } from '../types/internal'
import type { IndexSyncState } from './registry-entry'

export function syncStateOfMetadata(metadata: IndexMetadata): IndexSyncState | null {
  if (metadata.sync?.enabled !== true) return null
  const epoch = isSyncEpoch(metadata.syncEpoch) ? metadata.syncEpoch : null
  return {
    ...(metadata.sync.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: metadata.sync.historyMaxAgeMs } : {}),
    ...(metadata.sync.historyMaxBytes !== undefined ? { historyMaxBytes: metadata.sync.historyMaxBytes } : {}),
    active: epoch !== null && metadata.syncActive === true,
    epoch: epoch ?? newSyncEpoch(),
  }
}
