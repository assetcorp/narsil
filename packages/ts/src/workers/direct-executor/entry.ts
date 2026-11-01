import type { PartitionManager } from '../../partitioning/manager'
import type { VectorIndex } from '../../vector/vector-index'
import { createHeldVectorCopies } from '../vector-copies'
import type { IndexEntry } from './types'

export function indexEntryOf(
  manager: PartitionManager,
  vectorIndexes: Map<string, VectorIndex>,
  analysisStale: boolean,
  awaitedCopyLoad: string | null,
): IndexEntry {
  return {
    manager,
    get config() {
      return manager.config
    },
    get language() {
      return manager.language
    },
    searchOptions: {
      get stopWords() {
        return manager.analysis.stopWords
      },
      get customTokenizer() {
        return manager.analysis.customTokenizer
      },
      get synonyms() {
        return manager.synonyms
      },
    },
    vectorIndexes,
    vectorCopies: createHeldVectorCopies(),
    analysisStale,
    awaitedCopyLoad,
  }
}
