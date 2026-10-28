import { availableSynonymModule, isEmptySynonymSet, synonymModule } from '../core/synonyms/registry'
import type { EngineCore } from '../engine/core'
import { rulesOfStoredSynonyms } from '../engine/synonym-sets'
import type { SynonymOperations } from '../types/synonym-operations'
import type { SynonymRule } from '../types/synonyms'

export function synonymOperations(core: EngineCore): SynonymOperations {
  return {
    async updateSynonyms(indexName: string, synonyms: SynonymRule[]): Promise<void> {
      core.guardShutdown()
      const absent = core.requireIndex(indexName).synonyms === null && isEmptySynonymSet(synonyms)
      if (absent && availableSynonymModule() === null) return
      await synonymModule().replace(core, indexName, synonyms, true)
    },

    async getSynonyms(indexName: string): Promise<SynonymRule[]> {
      core.guardShutdown()
      return rulesOfStoredSynonyms(core.requireIndex(indexName).synonyms)
    },
  }
}
