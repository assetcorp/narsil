import { createPartitionManager, type PartitionManager } from '../partitioning/manager'
import { createPartitionRouter } from '../partitioning/router'
import { extractVectorFieldsFromSchema } from '../schema/validator'
import type { FulltextSearchOptions } from '../search/fulltext'
import type { LanguageModule } from '../types/language'
import type { IndexConfig, VectorStorageMode } from '../types/schema'
import { createVectorIndex, type VectorIndex, type VectorWorkerCopyPolicy } from '../vector/vector-index'
import { closeHeldVectorCopies, createHeldVectorCopies, type HeldVectorCopies } from './vector-copies'

export interface IndexEntry {
  manager: PartitionManager
  config: IndexConfig
  language: LanguageModule
  searchOptions: FulltextSearchOptions
  vectorIndexes: Map<string, VectorIndex>
  vectorCopies: HeldVectorCopies
  analysisStale: boolean
  awaitedCopyLoad: string | null
}

export interface IndexEntrySettings {
  vectorWorkerCopies: VectorWorkerCopyPolicy
  vectorStorage: VectorStorageMode
}

export interface DetachedIndex {
  readonly indexName: string
  readonly manager: PartitionManager
  readonly entry: IndexEntry
  attach(): void
}

export function vectorIndexesFor(
  indexName: string,
  config: IndexConfig,
  settings: IndexEntrySettings,
): Map<string, VectorIndex> {
  const vectorIndexes = new Map<string, VectorIndex>()
  for (const [fieldPath, dim] of extractVectorFieldsFromSchema(config.schema)) {
    vectorIndexes.set(
      fieldPath,
      createVectorIndex(
        fieldPath,
        dim,
        config.vectorPromotion,
        settings.vectorWorkerCopies,
        indexName,
        config.vectorPromotion?.storage ?? settings.vectorStorage,
      ),
    )
  }
  return vectorIndexes
}

export function createIndexEntry(
  indexName: string,
  config: IndexConfig,
  language: LanguageModule,
  analysisStale: boolean,
  awaitedCopyLoad: string | null,
  settings: IndexEntrySettings,
): IndexEntry {
  const partitionCount = config.partitions?.maxPartitions ?? 1
  const vectorIndexes = vectorIndexesFor(indexName, config, settings)
  const manager = createPartitionManager(
    indexName,
    config,
    language,
    createPartitionRouter(),
    partitionCount,
    vectorIndexes,
  )
  return {
    manager,
    config,
    language,
    searchOptions: {
      bm25Params: config.bm25,
      stopWords: manager.analysis.stopWords,
      customTokenizer: manager.analysis.customTokenizer,
    },
    vectorIndexes,
    vectorCopies: createHeldVectorCopies(),
    analysisStale,
    awaitedCopyLoad,
  }
}

export function disposeIndexEntry(entry: IndexEntry): void {
  for (const vectorIndex of entry.vectorIndexes.values()) {
    vectorIndex.dispose()
  }
  closeHeldVectorCopies(entry.vectorCopies)
  for (const partition of entry.manager.getAllPartitions()) {
    partition.clear()
  }
}

function attachablePolicy(shared: VectorWorkerCopyPolicy): { policy: VectorWorkerCopyPolicy; attach(): void } {
  let attached = false
  const policy: VectorWorkerCopyPolicy = {
    get enabled() {
      return attached && shared.enabled
    },
    get count() {
      return shared.count
    },
    get host() {
      return shared.host
    },
  }
  return {
    policy,
    attach() {
      attached = true
    },
  }
}

export function createDetachedIndex(
  indexName: string,
  config: IndexConfig,
  language: LanguageModule,
  analysisStale: boolean,
  settings: IndexEntrySettings,
): DetachedIndex {
  const { policy, attach } = attachablePolicy(settings.vectorWorkerCopies)
  const entry = createIndexEntry(indexName, config, language, analysisStale, null, {
    ...settings,
    vectorWorkerCopies: policy,
  })
  return { indexName, manager: entry.manager, entry, attach }
}
