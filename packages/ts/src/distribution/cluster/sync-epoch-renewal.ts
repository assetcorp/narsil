import { newSyncEpoch } from '../../sync/epoch'
import type { ClusterCoordinator } from '../coordinator/types'
import { SYNC_EPOCH_CAS_ATTEMPTS } from './constants'
import { indexConfigKey, readIndexMetadataSnapshot } from './index-metadata'
import { metadataWithSync } from './sync-settings'

export async function renewClusterSyncEpoch(coordinator: ClusterCoordinator, indexName: string): Promise<boolean> {
  for (let attempt = 1; attempt <= SYNC_EPOCH_CAS_ATTEMPTS; attempt++) {
    const current = await readIndexMetadataSnapshot(coordinator, indexName)
    if (current === null) return false
    const sync = current.settings?.sync
    if (sync?.enabled !== true) return true
    const next = metadataWithSync(current, { sync, syncActive: false, syncEpoch: newSyncEpoch() })
    if (await coordinator.compareAndSet(indexConfigKey(indexName), current.bytes, next)) return true
  }
  return false
}
