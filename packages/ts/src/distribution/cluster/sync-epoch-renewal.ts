import { newSyncEpoch } from '../../sync/epoch'
import type { ClusterCoordinator } from '../coordinator/types'
import { SYNC_EPOCH_CAS_ATTEMPTS } from './constants'
import { indexConfigKey, readIndexMetadataSnapshot } from './index-metadata'
import { epochFeaturesOn, metadataWithSync, syncSettingsOfSnapshot } from './sync-settings'

export async function renewClusterSyncEpoch(coordinator: ClusterCoordinator, indexName: string): Promise<boolean> {
  for (let attempt = 1; attempt <= SYNC_EPOCH_CAS_ATTEMPTS; attempt++) {
    const current = await readIndexMetadataSnapshot(coordinator, indexName)
    if (current === null) return false
    const held = syncSettingsOfSnapshot(current)
    if (!epochFeaturesOn(held)) return true
    const next = metadataWithSync(current, { ...held, syncActive: false, syncEpoch: newSyncEpoch() })
    if (await coordinator.compareAndSet(indexConfigKey(indexName), current.bytes, next)) return true
  }
  return false
}
