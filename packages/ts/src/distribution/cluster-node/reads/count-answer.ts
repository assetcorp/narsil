import type { PartitionStatsResult } from '../../../types/results'
import type { CountResultPayload, PartitionCountEntry } from '../../transport/types'
import type { ClusterLocalEngine } from '../local-engine'

function vectorSharesOf(held: readonly PartitionStatsResult[], vectorBytes: number): Map<number, number> {
  const shares = new Map<number, number>()
  if (held.length === 0) return shares
  const total = BigInt(vectorBytes)
  let documents = 0n
  let lowestPartitionId = held[0].partitionId
  for (const partition of held) {
    documents += BigInt(partition.documentCount)
    lowestPartitionId = Math.min(lowestPartitionId, partition.partitionId)
  }
  let given = 0n
  for (const partition of held) {
    const share = documents > 0n ? (total * BigInt(partition.documentCount)) / documents : total / BigInt(held.length)
    shares.set(partition.partitionId, Number(share))
    given += share
  }
  shares.set(lowestPartitionId, (shares.get(lowestPartitionId) ?? 0) + Number(total - given))
  return shares
}

function countEntryOf(partition: PartitionStatsResult, vectorShare: number | undefined): PartitionCountEntry {
  return {
    partitionId: partition.partitionId,
    documentCount: partition.documentCount,
    estimatedMemoryBytes: partition.estimatedMemoryBytes,
    ...(partition.savedBytes === undefined ? {} : { savedBytes: partition.savedBytes }),
    ...(vectorShare === undefined ? {} : { vectorSavedBytes: vectorShare }),
    ...(partition.logBytes === undefined ? {} : { logBytes: partition.logBytes }),
  }
}

export async function localCountAnswer(
  engine: ClusterLocalEngine,
  indexName: string,
  partitionIds: readonly number[],
): Promise<CountResultPayload> {
  const { partitions, vectorSavedBytes } = await engine.partitionStatsForRead(indexName)
  const heldIds = engine.heldPartitionsOf(indexName)
  const held =
    heldIds === undefined ? partitions : partitions.filter(partition => heldIds.includes(partition.partitionId))
  const shares = vectorSavedBytes === undefined ? new Map<number, number>() : vectorSharesOf(held, vectorSavedBytes)
  const requested = new Set(partitionIds)
  return {
    partitions: partitions
      .filter(partition => requested.has(partition.partitionId))
      .map(partition => countEntryOf(partition, shares.get(partition.partitionId))),
    language: engine.getStats(indexName).language,
  }
}
