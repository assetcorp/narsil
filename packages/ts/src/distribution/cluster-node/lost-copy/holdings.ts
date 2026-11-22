import type { ClusterLocalEngine } from '../local-engine'
import { heldPartitionIdsOf } from '../message-handler/partition-stores'

export interface LocalHoldings {
  engine: ClusterLocalEngine
  isOrphaned(indexName: string): boolean
}

function adopts(holdings: LocalHoldings, indexName: string, indexUuid: string): boolean {
  const { engine, isOrphaned } = holdings
  return !isOrphaned(indexName) && engine.indexUuidOf(indexName) === indexUuid
}

async function unlistedAmong(
  engine: ClusterLocalEngine,
  indexName: string,
  partitionIds: readonly number[],
): Promise<number[]> {
  const recorded = new Set(engine.heldPartitionsOf(indexName))
  if (partitionIds.every(partitionId => recorded.has(partitionId))) return []
  await engine.open(indexName)
  const listed = new Set(heldPartitionIdsOf(engine, indexName))
  return partitionIds.filter(partitionId => !listed.has(partitionId))
}

export async function partitionsWithoutCopy(
  holdings: LocalHoldings,
  indexName: string,
  indexUuid: string,
  assigned: readonly number[],
): Promise<number[]> {
  if (!adopts(holdings, indexName, indexUuid)) return [...assigned]
  if (holdings.engine.heldPartitionsOf(indexName) === undefined) return []
  return unlistedAmong(holdings.engine, indexName, assigned)
}

export async function canListCopy(
  holdings: LocalHoldings,
  indexName: string,
  indexUuid: string | undefined,
  partitionId: number,
): Promise<boolean> {
  if (indexUuid === undefined || !adopts(holdings, indexName, indexUuid)) return false
  return (await unlistedAmong(holdings.engine, indexName, [partitionId])).length === 0
}
