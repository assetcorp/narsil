import { tokenize } from '../core/tokenizer'
import type { InvalidationAdapter } from '../types/adapters'
import type { GlobalStatistics } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { CustomTokenizer, StopWordOverride } from '../types/schema'
import type { PartitionManager } from './manager'

export interface QueryTermAnalysis {
  stopWords?: StopWordOverride
  customTokenizer?: CustomTokenizer
}

function analysedQueryTokens(term: string, language: LanguageModule, analysis: QueryTermAnalysis): Set<string> {
  const { tokens } = tokenize(term, language, {
    stem: true,
    removeStopWords: true,
    customTokenizer: analysis.customTokenizer,
    stopWordOverride: analysis.stopWords,
  })
  const unique = new Set<string>()
  for (const { token } of tokens) {
    unique.add(token)
  }
  return unique
}

function copyNumericRecord(source: Record<string, number>): Record<string, number> {
  const copy: Record<string, number> = Object.create(null)
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      copy[key] = value
    }
  }
  return copy
}

export function sanitizeGlobalStats(stats: GlobalStatistics): GlobalStatistics {
  return {
    totalDocuments:
      typeof stats.totalDocuments === 'number' && Number.isFinite(stats.totalDocuments) ? stats.totalDocuments : 0,
    docFrequencies: copyNumericRecord(stats.docFrequencies),
    totalFieldLengths: copyNumericRecord(stats.totalFieldLengths),
    averageFieldLengths: copyNumericRecord(stats.averageFieldLengths),
  }
}

export function pruneStatsToQueryTerms(
  stats: GlobalStatistics,
  term: string,
  language: LanguageModule,
  analysis: QueryTermAnalysis,
): GlobalStatistics {
  const docFrequencies: Record<string, number> = Object.create(null)
  for (const token of analysedQueryTokens(term, language, analysis)) {
    if (Object.hasOwn(stats.docFrequencies, token)) {
      docFrequencies[token] = stats.docFrequencies[token]
    }
  }
  return {
    totalDocuments: stats.totalDocuments,
    docFrequencies,
    totalFieldLengths: stats.totalFieldLengths,
    averageFieldLengths: stats.averageFieldLengths,
  }
}

export function collectQueryTermStats(
  manager: PartitionManager,
  term: string,
  language: LanguageModule,
  analysis: QueryTermAnalysis,
  partitionIds?: number[],
): GlobalStatistics {
  const queryTokens = analysedQueryTokens(term, language, analysis)
  let totalDocuments = 0
  const docFrequencies: Record<string, number> = Object.create(null)
  const totalFieldLengths: Record<string, number> = Object.create(null)

  const statsPartitions =
    partitionIds === undefined
      ? manager.getAllPartitions()
      : partitionIds
          .map(partitionId => manager.partitionAt(partitionId))
          .filter((partition): partition is NonNullable<typeof partition> => partition !== undefined)

  for (const partition of statsPartitions) {
    const stats = partition.stats
    totalDocuments += stats.totalDocuments
    for (const [field, length] of Object.entries(stats.totalFieldLengths)) {
      totalFieldLengths[field] = (totalFieldLengths[field] ?? 0) + length
    }
    for (const token of queryTokens) {
      if (Object.hasOwn(stats.docFrequencies, token)) {
        docFrequencies[token] = (docFrequencies[token] ?? 0) + stats.docFrequencies[token]
      }
    }
  }

  const averageFieldLengths: Record<string, number> = Object.create(null)
  if (totalDocuments > 0) {
    for (const [field, totalLength] of Object.entries(totalFieldLengths)) {
      averageFieldLengths[field] = totalLength / totalDocuments
    }
  }

  return { totalDocuments, docFrequencies, totalFieldLengths, averageFieldLengths }
}

export function collectGlobalStats(manager: PartitionManager): GlobalStatistics {
  const aggregate = manager.getAggregateStats()
  const averageFieldLengths: Record<string, number> = Object.create(null)

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
  const docFrequencies: Record<string, number> = Object.create(null)
  const totalFieldLengths: Record<string, number> = Object.create(null)

  for (const stats of statsArray) {
    totalDocuments += stats.totalDocuments

    for (const [term, freq] of Object.entries(stats.docFrequencies)) {
      docFrequencies[term] = (docFrequencies[term] ?? 0) + freq
    }

    for (const [field, length] of Object.entries(stats.totalFieldLengths)) {
      totalFieldLengths[field] = (totalFieldLengths[field] ?? 0) + length
    }
  }

  const averageFieldLengths: Record<string, number> = Object.create(null)

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
