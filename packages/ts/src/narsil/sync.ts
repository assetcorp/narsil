import type { EngineCore } from '../engine/core'
import { loadStorageCode } from '../persistence/storage-code'
import type { SyncOperations } from '../types/sync'

export function syncOperations(core: EngineCore): SyncOperations {
  return {
    updateSync: async (indexName, setting) => (await loadStorageCode()).updateSyncOf(core, indexName, setting),
    getSync: async indexName => (await loadStorageCode()).syncOf(core, indexName),
  }
}
