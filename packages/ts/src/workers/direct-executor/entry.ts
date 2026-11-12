import { createPartitionManager, type PartitionManager } from '../../partitioning/manager'
import { createPartitionRouter } from '../../partitioning/router'
import { extractVectorFieldsFromSchema } from '../../schema/validator'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig, VectorStorageMode } from '../../types/schema'
import type { VectorIndex, VectorWorkerCopyPolicy } from '../../vector/vector-index'
import { requireLoadedVectorCode } from '../vector-code'
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

export function vectorIndexesFor(
  indexName: string,
  config: IndexConfig,
  copies: VectorWorkerCopyPolicy,
  vectorStorage: VectorStorageMode,
  onVectorGraphRepaired: ((indexName: string) => void) | undefined,
): Map<string, VectorIndex> {
  const vectorIndexes = new Map<string, VectorIndex>()
  const vectorFields = extractVectorFieldsFromSchema(config.schema)
  if (vectorFields.size === 0) return vectorIndexes
  const { createVectorIndex } = requireLoadedVectorCode()
  const promotion = config.vectorPromotion
  const storage = promotion?.storage ?? vectorStorage
  const repaired = (): void => onVectorGraphRepaired?.(indexName)
  for (const [fieldPath, dim] of vectorFields) {
    const index = createVectorIndex(fieldPath, dim, promotion, copies, indexName, storage, repaired)
    vectorIndexes.set(fieldPath, index)
  }
  return vectorIndexes
}

export function disposeEntry(entry: IndexEntry): Promise<void> {
  closeCopyPublicationOrder(entry.copyPublications)
  return entry.manager.afterSearchesRelease(() => {
    const disposals = [...entry.vectorIndexes.values()].map(vectorIndex => vectorIndex.dispose())
    closeHeldVectorCopies(entry.vectorCopies)
    for (const partition of entry.manager.getAllPartitions()) partition.clear()
    return Promise.all(disposals).then(() => undefined)
  })
}

export function createEntryBuilder(
  vectorStorage: VectorStorageMode,
  onVectorGraphRepaired: ((indexName: string) => void) | undefined,
  pendingDisposals: Set<Promise<void>>,
) {
  return (
    indexName: string,
    config: IndexConfig,
    language: LanguageModule,
    analysisStale: boolean,
    awaitedCopyLoad: string | null,
    copies: VectorWorkerCopyPolicy,
    savedPartitionCount: number | undefined,
  ): IndexEntry => {
    const router = createPartitionRouter()
    const partitionCount = savedPartitionCount ?? config.partitions?.maxPartitions ?? 1
    const vectorIndexes = vectorIndexesFor(indexName, config, copies, vectorStorage, onVectorGraphRepaired)
    const manager = createPartitionManager(
      indexName,
      config,
      language,
      router,
      partitionCount,
      vectorIndexes,
      pendingDisposals,
    )
    return indexEntryOf(manager, vectorIndexes, analysisStale, awaitedCopyLoad)
  }
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
