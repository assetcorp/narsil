import type { EngineCore } from '../engine/core'
import type { SyncOperations } from '../types/sync'

export function syncOperations(core: EngineCore): SyncOperations {
  return {
    updateSync: async (indexName, setting) =>
      (await import('../engine/sync/methods')).updateSyncOf(core, indexName, setting),
    getSync: async indexName => (await import('../engine/sync/methods')).syncOf(core, indexName),
  }
}
