import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import type { IndexConfig } from '../../types/schema'
import type { VectorIndex } from '../../vector/vector-index'
import { createHeldVectorCopies } from '../vector-copies'
import type { IndexEntry } from './types'

export function entryPartitionCount(
  indexName: string,
  config: IndexConfig,
  savedPartitionCount: number | undefined,
): number {
  const partitionCount = savedPartitionCount ?? config.partitions?.maxPartitions ?? 1
  if (!Number.isSafeInteger(partitionCount) || partitionCount < 1) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Index "${indexName}" needs a whole number of partitions above zero, received ${String(partitionCount)}`,
      { indexName, partitionCount },
    )
  }
  return partitionCount
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
  }
}
