import type { EngineCore } from '../engine/core'
import { loadStorageCode } from '../persistence/storage-code'
import type { ChangesOperations } from '../types/changes'

export function changesOperations(core: EngineCore): ChangesOperations {
  return {
    updateChanges: async (indexName, setting) => (await loadStorageCode()).updateChangesOf(core, indexName, setting),
    getChanges: async indexName => (await loadStorageCode()).changesOf(core, indexName),
    async *followChanges(indexName, options) {
      yield* (await loadStorageCode()).followIndexChanges(core, indexName, options)
    },
  }
}
