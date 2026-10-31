import { ErrorCodes, NarsilError } from '../../../errors'
import type { AllocationTable, ClusterCoordinator } from '../../coordinator/types'
import { HIDDEN_GENERATION_PREFIX, TEARDOWN_CAS_ATTEMPTS } from '../constants'
import { indexConfigKey, putGenerationMetadata, storedSynonymSetOf } from '../index-metadata'
import { deleteSynonymSet } from '../synonym-set'
import { clearRebalanceProgress, type RebalanceRecord } from './records'

export async function ensureGeneration(coordinator: ClusterCoordinator, record: RebalanceRecord): Promise<void> {
  const written = await putGenerationMetadata(coordinator, record.sourceGeneration, {
    indexName: record.targetGeneration,
    indexUuid: record.targetGeneration.slice(HIDDEN_GENERATION_PREFIX.length),
    partitionCount: record.targetPartitionCount,
  })
  if (!written) {
    throw new NarsilError(
      ErrorCodes.INDEX_NOT_FOUND,
      `Index '${record.sourceGeneration}' lost its metadata before its new partition layout was created`,
      { indexName: record.sourceGeneration, targetGeneration: record.targetGeneration },
    )
  }
  if ((await coordinator.getSchema(record.targetGeneration)) !== null) return
  const schema = await coordinator.getSchema(record.sourceGeneration)
  if (schema === null) {
    throw new NarsilError(
      ErrorCodes.INDEX_NOT_FOUND,
      `Index '${record.sourceGeneration}' lost its schema before its new partition layout was created`,
      { indexName: record.sourceGeneration, targetGeneration: record.targetGeneration },
    )
  }
  await coordinator.putSchema(record.targetGeneration, schema)
}

async function emptyAllocation(coordinator: ClusterCoordinator, writerNodeId: string, indexName: string) {
  for (let attempt = 0; attempt < TEARDOWN_CAS_ATTEMPTS; attempt++) {
    const table = await coordinator.getAllocation(indexName)
    if (table === null || table.assignments.size === 0) return
    const empty: AllocationTable = {
      indexName,
      version: table.version + 1,
      replicationFactor: table.replicationFactor,
      assignments: new Map(),
    }
    if (table.indexUuid !== undefined) empty.indexUuid = table.indexUuid
    if (await coordinator.putAllocation(indexName, empty, table.version, writerNodeId)) return
  }
  throw new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `Teardown of the allocation for index '${indexName}' lost every compare-and-set attempt`,
    { indexName, attempts: TEARDOWN_CAS_ATTEMPTS },
  )
}

export async function dropGeneration(
  coordinator: ClusterCoordinator,
  writerNodeId: string,
  generation: string,
): Promise<void> {
  await emptyAllocation(coordinator, writerNodeId, generation)
  const key = indexConfigKey(generation)
  const metadata = await coordinator.get(key)
  if (metadata !== null && metadata.byteLength > 0) {
    if (await coordinator.compareAndSet(key, metadata, new Uint8Array(0))) {
      const stored = storedSynonymSetOf(metadata)
      if (stored !== null) await deleteSynonymSet(coordinator, stored.indexUuid, stored.ref)
    }
  }
  if ((await coordinator.getSchema(generation)) !== null) {
    await coordinator.dropSchema(generation)
    return
  }
  await coordinator.deleteAllocation(generation)
}

export async function clearEveryProgress(
  coordinator: ClusterCoordinator,
  indexName: string,
  partitionCount: number,
): Promise<void> {
  for (let partitionId = 0; partitionId < partitionCount; partitionId++) {
    await clearRebalanceProgress(coordinator, indexName, partitionId)
  }
}
