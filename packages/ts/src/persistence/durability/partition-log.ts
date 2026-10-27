import type { PartitionRegistry } from './partition-registry'
import type { DurabilityManager, PartitionLogPosition } from './types'

export function persistedPosition(
  manager: DurabilityManager,
  indexName: string,
  partitionId: number,
): PartitionLogPosition {
  const partition = manager.partitionRegistry?.indexes.get(indexName)?.partitions.get(partitionId)
  if (partition !== undefined) return { seqNo: partition.appliedSeqNo, primaryTerm: partition.seqOwner.primaryTerm }
  return { seqNo: manager.highestPersistedSeqNo(indexName, partitionId), primaryTerm: 0 }
}

async function replacePartitionLog(
  registry: PartitionRegistry,
  indexName: string,
  partitionId: number,
  position: PartitionLogPosition,
): Promise<void> {
  const state = registry.indexState(indexName)
  if (state.checkpointInFlight !== null) await state.checkpointInFlight.catch(() => undefined)
  const previous = state.partitions.get(partitionId)
  if (previous !== undefined) {
    await previous.appendChain
    await previous.walWriter.close()
  }
  for (const key of await registry.directory.list(`${indexName}/wal/${partitionId}/`)) {
    await registry.directory.remove(key)
  }
  state.partitions.set(partitionId, registry.freshPartition(indexName, partitionId, position))
}

export async function restartPartitionLog(
  manager: DurabilityManager,
  indexName: string,
  partitionId: number,
  position: PartitionLogPosition,
): Promise<void> {
  const registry = manager.partitionRegistry
  if (registry === undefined || manager.checkpointFromMemory === undefined) return
  await replacePartitionLog(registry, indexName, partitionId, position)
  await manager.checkpointFromMemory(indexName)
}
