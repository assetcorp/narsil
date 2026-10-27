import type { PartitionIndex } from '../../core/partition'
import type { PartitionStatsResult } from '../../types/results'
import type { VectorIndex } from '../../vector/vector-index'
import type { PartitionManager } from './types'

export function aggregateStatsOf(
  partitions: readonly PartitionIndex[],
): ReturnType<PartitionManager['getAggregateStats']> {
  let totalDocuments = 0
  const docFrequencies: Record<string, number> = Object.create(null)
  const totalFieldLengths: Record<string, number> = Object.create(null)

  for (let i = 0; i < partitions.length; i++) {
    const stats = partitions[i].stats
    totalDocuments += stats.totalDocuments

    for (const [term, freq] of Object.entries(stats.docFrequencies)) {
      docFrequencies[term] = (docFrequencies[term] ?? 0) + freq
    }

    for (const [field, length] of Object.entries(stats.totalFieldLengths)) {
      totalFieldLengths[field] = (totalFieldLengths[field] ?? 0) + length
    }
  }

  return { totalDocuments, docFrequencies, totalFieldLengths }
}

export function estimateBytesOf(
  partitions: readonly PartitionIndex[],
  vecIndexes: ReadonlyMap<string, VectorIndex>,
): number {
  let total = 0
  for (let i = 0; i < partitions.length; i++) {
    total += partitions[i].estimateMemoryBytes()
  }
  for (const [, vecIndex] of vecIndexes) {
    total += vecIndex.estimateMemoryBytes()
  }
  return total
}

export function partitionStatsOf(partitions: readonly PartitionIndex[]): PartitionStatsResult[] {
  return partitions.map((p, i) => ({
    partitionId: i,
    documentCount: p.count(),
    estimatedMemoryBytes: p.estimateMemoryBytes(),
  }))
}
