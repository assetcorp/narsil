import type { InvalidationAdapter } from '../types/adapters'
import type { GlobalStatistics } from '../types/internal'
import type { PartitionManager } from './manager'

export function collectGlobalStats(manager: PartitionManager): GlobalStatistics {
  const aggregate = manager.getAggregateStats()
  const averageFieldLengths: Record<string, number> = {}

  if (aggregate.totalDocuments > 0) {
    for (const [field, totalLength] of Object.entries(aggregate.totalFieldLengths)) {
      averageFieldLengths[field] = totalLength / aggregate.totalDocuments
    }
  }

  return {
    totalDocuments: aggregate.totalDocuments,
    docFrequencies: aggregate.docFrequencies,
    totalFieldLengths: aggregate.totalFieldLengths,
    averageFieldLengths,
  }
}

export function mergePartitionStats(
  statsArray: Array<{
    totalDocuments: number
    docFrequencies: Record<string, number>
    totalFieldLengths: Record<string, number>
  }>,
): GlobalStatistics {
  let totalDocuments = 0
  const docFrequencies: Record<string, number> = {}
  const totalFieldLengths: Record<string, number> = {}

  for (const stats of statsArray) {
    totalDocuments += stats.totalDocuments

    for (const [term, freq] of Object.entries(stats.docFrequencies)) {
      docFrequencies[term] = (docFrequencies[term] ?? 0) + freq
    }

    for (const [field, length] of Object.entries(stats.totalFieldLengths)) {
      totalFieldLengths[field] = (totalFieldLengths[field] ?? 0) + length
    }
  }

  const averageFieldLengths: Record<string, number> = {}

  if (totalDocuments > 0) {
    for (const [field, totalLength] of Object.entries(totalFieldLengths)) {
      averageFieldLengths[field] = totalLength / totalDocuments
    }
  }

  return {
    totalDocuments,
    docFrequencies,
    totalFieldLengths,
    averageFieldLengths,
  }
}

export function setupStatisticsBroadcast(
  manager: PartitionManager,
  invalidation: InvalidationAdapter,
  instanceId: string,
  interval: number,
): { shutdown: () => void } {
  const handle = setInterval(() => {
    const aggregate = manager.getAggregateStats()
    invalidation.publish({
      type: 'statistics',
      indexName: manager.indexName,
      instanceId,
      stats: {
        totalDocs: aggregate.totalDocuments,
        docFrequencies: aggregate.docFrequencies,
        totalFieldLengths: aggregate.totalFieldLengths,
      },
    })
  }, interval)

  return {
    shutdown() {
      clearInterval(handle)
    },
  }
}
