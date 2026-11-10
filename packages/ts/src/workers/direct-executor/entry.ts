import type { PartitionManager } from '../../partitioning/manager'
import type { VectorIndex } from '../../vector/vector-index'
import { closeHeldVectorCopies, createHeldVectorCopies } from '../vector-copies'
import { closeCopyPublicationOrder, createCopyPublicationOrder } from './publication'
import type { IndexEntry, IndexQueryContext } from './types'

export function queryContextOfEntry(entry: IndexEntry | undefined): IndexQueryContext | undefined {
  if (entry === undefined || entry.awaitedCopyLoad !== null || entry.copyPublications.failed) return undefined
  return {
    manager: entry.manager,
    config: entry.config,
    language: entry.language,
    vectorSearchers: entry.vectorCopies.searchers,
    analysisStale: entry.analysisStale,
  }
}

export function disposeEntry(entry: IndexEntry): void {
  closeCopyPublicationOrder(entry.copyPublications)
  entry.manager.afterSearchesRelease(() => {
    for (const vectorIndex of entry.vectorIndexes.values()) vectorIndex.dispose()
    closeHeldVectorCopies(entry.vectorCopies)
    for (const partition of entry.manager.getAllPartitions()) partition.clear()
  })
}

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
    copyPublications: createCopyPublicationOrder(),
  }
}
