import type { PartitionIndex } from '../../core/partition'
import { partitionDocumentFrequency } from '../../core/partition/document-frequency'
import type { PartitionStatsResult } from '../../types/results'
import type { VectorIndex } from '../../vector/vector-index'
import { STATISTICS_MESSAGE_ENTRY_BYTES } from './constants'
import type { PartitionManager } from './types'
import type { WriteLogRecorder } from './write-log'

type AggregateStats = ReturnType<PartitionManager['getAggregateStats']>

export type StatsOperations = Pick<
  PartitionManager,
  'getAggregateStats' | 'statisticsMessage' | 'estimateMemoryBytes' | 'getPartitionStats'
>

export function createStatsOperations(
  partitionsOf: () => readonly PartitionIndex[],
  vecIndexes: ReadonlyMap<string, VectorIndex>,
  writeLogs: Pick<WriteLogRecorder, 'generation'>,
): StatsOperations {
  let sent: AggregateStats | null = null
  let sentGeneration = 0
  let sentTerms = 0
  return {
    getAggregateStats(tokens) {
      return collectAggregate(partitionsOf(), tokens).stats
    },
    statisticsMessage() {
      const generation = writeLogs.generation
      if (sent !== null && sentGeneration === generation) return sent
      const collected = collectAggregate(partitionsOf(), undefined)
      sent = collected.stats
      sentGeneration = generation
      sentTerms = collected.terms
      return sent
    },
    estimateMemoryBytes() {
      return estimateBytesOf(partitionsOf(), vecIndexes) + sentTerms * STATISTICS_MESSAGE_ENTRY_BYTES
    },
    getPartitionStats() {
      return partitionStatsOf(partitionsOf())
    },
  }
}

function collectAggregate(
  partitions: readonly PartitionIndex[],
  tokens: ReadonlySet<string> | undefined,
): { stats: AggregateStats; terms: number } {
  let totalDocuments = 0
  let terms = 0
  const docFrequencies: Record<string, number> = Object.create(null)
  const totalFieldLengths: Record<string, number> = Object.create(null)

  for (let i = 0; i < partitions.length; i++) {
    const stats = partitions[i].stats
    totalDocuments += stats.totalDocuments

    if (tokens === undefined) {
      terms += stats.addDocumentFrequencies(docFrequencies)
    } else {
      const states = partitions[i].readStates()
      for (const token of tokens) {
        const documents = partitionDocumentFrequency(states, token)
        if (documents > 0) docFrequencies[token] = (docFrequencies[token] ?? 0) + documents
      }
    }

    for (const [field, length] of Object.entries(stats.totalFieldLengths)) {
      totalFieldLengths[field] = (totalFieldLengths[field] ?? 0) + length
    }
  }

  return { stats: { totalDocuments, docFrequencies, totalFieldLengths }, terms }
}

function estimateBytesOf(partitions: readonly PartitionIndex[], vecIndexes: ReadonlyMap<string, VectorIndex>): number {
  let total = 0
  for (let i = 0; i < partitions.length; i++) {
    total += partitions[i].estimateMemoryBytes()
  }
  for (const [, vecIndex] of vecIndexes) {
    total += vecIndex.estimateMemoryBytes()
  }
  return total
}

function partitionStatsOf(partitions: readonly PartitionIndex[]): PartitionStatsResult[] {
  return partitions.map((p, i) => ({
    partitionId: i,
    documentCount: p.count(),
    estimatedMemoryBytes: p.estimateMemoryBytes(),
  }))
}
