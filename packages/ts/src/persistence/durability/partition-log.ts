import { closePartitionWriter } from './manager-state'
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

async function closePrevious(registry: PartitionRegistry, indexName: string, partitionId: number): Promise<void> {
  const state = registry.indexState(indexName)
  if (state.checkpointInFlight !== null) await state.checkpointInFlight.catch(() => undefined)
  const previous = state.partitions.get(partitionId)
  if (previous === undefined) return
  if (previous.failed === null) await previous.appendChain
  else await previous.appendChain.catch(() => undefined)
  await closePartitionWriter(previous)
}

export async function reopenPartitionLogAfterReplay(
  manager: DurabilityManager,
  indexName: string,
  partitionId: number,
  replay: () => Promise<PartitionLogPosition>,
): Promise<void> {
  const registry = manager.partitionRegistry
  if (registry === undefined) return
  await closePrevious(registry, indexName, partitionId)
  const position = await replay()
  registry.indexState(indexName).partitions.set(partitionId, registry.freshPartition(indexName, partitionId, position))
}

async function replacePartitionLog(
  registry: PartitionRegistry,
  indexName: string,
  partitionId: number,
  position: PartitionLogPosition,
): Promise<void> {
  await closePrevious(registry, indexName, partitionId)
  for (const key of await registry.directory.list(`${indexName}/wal/${partitionId}/`)) {
    await registry.directory.remove(key)
  }
  registry.indexState(indexName).partitions.set(partitionId, registry.freshPartition(indexName, partitionId, position))
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
