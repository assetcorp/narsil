import { ErrorCodes, NarsilError } from '../../errors'
import { TEARDOWN_CAS_ATTEMPTS } from '../cluster/constants'
import { getIndexMetadata, indexConfigKey, storedSynonymSetOf } from '../cluster/index-metadata'
import { pause } from '../cluster/rebalance/pause'
import { deleteSynonymSet } from '../cluster/synonym-set'
import type { AllocationTable, ClusterCoordinator } from '../coordinator/types'
import { BACKUP_PUBLISH_RETRY_MS } from './constants'
import { assertStillDriving, type BackupDriverContext, jobIndexNameOf } from './driver-context'

export function nameTaken(indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.INDEX_ALREADY_EXISTS,
    `Index '${indexName}' already exists in the cluster, so the restore creates nothing`,
    { indexName },
  )
}

export async function refuseTakenName(coordinator: ClusterCoordinator, indexName: string): Promise<void> {
  if (
    (await getIndexMetadata(coordinator, indexName)) !== null ||
    (await coordinator.getSchema(indexName)) !== null ||
    (await coordinator.getAllocation(indexName)) !== null
  ) {
    throw nameTaken(indexName)
  }
}

export async function servesGeneration(
  coordinator: ClusterCoordinator,
  indexName: string,
  generation: string,
): Promise<boolean> {
  return (await coordinator.getAllocation(indexName))?.generation === generation
}

async function withdrawGenerationMetadata(coordinator: ClusterCoordinator, generation: string): Promise<void> {
  const key = indexConfigKey(generation)
  for (let attempt = 0; attempt < TEARDOWN_CAS_ATTEMPTS; attempt++) {
    const stored = await coordinator.get(key)
    if (stored === null || stored.byteLength === 0) return
    if (await coordinator.compareAndSet(key, stored, new Uint8Array(0))) {
      const synonyms = storedSynonymSetOf(stored)
      if (synonyms !== null) await deleteSynonymSet(coordinator, synonyms.indexUuid, synonyms.ref)
      return
    }
  }
  throw new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `Withdrawing the metadata of '${generation}' lost every compare-and-set attempt`,
    { generation, attempts: TEARDOWN_CAS_ATTEMPTS },
  )
}

export async function dropUnpublishedGeneration(
  coordinator: ClusterCoordinator,
  indexName: string,
  generation: string,
): Promise<void> {
  if (await servesGeneration(coordinator, indexName, generation)) return
  await withdrawGenerationMetadata(coordinator, generation)
  if ((await coordinator.getSchema(generation)) !== null) await coordinator.dropSchema(generation)
}

function pointerNotWritten(indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `The controller could not point index '${indexName}' at its restored partitions yet`,
    { indexName },
  )
}

async function pointNameAtGeneration(
  context: BackupDriverContext,
  indexName: string,
  generation: string,
  indexUuid: string,
): Promise<void> {
  const { coordinator } = context.config
  const current = await coordinator.getAllocation(indexName)
  if (current !== null) {
    if (current.generation !== generation) throw nameTaken(indexName)
    return
  }
  const metadata = await getIndexMetadata(coordinator, indexName)
  if (metadata === null || metadata.indexUuid !== indexUuid) throw nameTaken(indexName)
  const pointer: AllocationTable = {
    indexName,
    version: 1,
    replicationFactor: metadata.replicationFactor,
    assignments: new Map(),
    generation,
    indexUuid,
  }
  if (await coordinator.putAllocation(indexName, pointer, null, context.nodeId)) return
  if (!(await servesGeneration(coordinator, indexName, generation))) throw pointerNotWritten(indexName)
}

async function publishSchema(context: BackupDriverContext, indexName: string, generation: string): Promise<void> {
  const { coordinator } = context.config
  if ((await coordinator.getSchema(indexName)) !== null) return
  const schema = await coordinator.getSchema(generation)
  if (schema === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `The restored partitions of '${indexName}' lost their schema`, {
      indexName,
      generation,
    })
  }
  await coordinator.putSchema(indexName, schema)
}

const FINAL_PUBLICATION_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.INDEX_ALREADY_EXISTS,
  ErrorCodes.INDEX_NOT_FOUND,
  ErrorCodes.NODE_NOT_CONTROLLER,
])

export async function publishRestoredName(
  context: BackupDriverContext,
  generation: string,
  indexUuid: string,
): Promise<void> {
  const indexName = jobIndexNameOf(context)
  for (;;) {
    assertStillDriving(context)
    try {
      await pointNameAtGeneration(context, indexName, generation, indexUuid)
      await publishSchema(context, indexName, generation)
      return
    } catch (error) {
      if (error instanceof NarsilError && FINAL_PUBLICATION_CODES.has(error.code)) throw error
      context.onError(error)
    }
    await pause(BACKUP_PUBLISH_RETRY_MS)
  }
}

function interrupted(context: BackupDriverContext): NarsilError {
  return new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `The controller that ran the restore of backup '${context.job.backupName}' stopped before the index was ready, so the restore created no index`,
    { backupName: context.job.backupName, jobId: context.jobId },
  )
}

export async function resumeRestore(context: BackupDriverContext): Promise<void> {
  const { coordinator } = context.config
  const { generation, nameIndexUuid } = context.job
  const indexName = jobIndexNameOf(context)
  if (generation === undefined) throw interrupted(context)
  const metadata = await getIndexMetadata(coordinator, indexName)
  if (nameIndexUuid !== undefined && metadata?.indexUuid === nameIndexUuid) {
    await publishRestoredName(context, generation, nameIndexUuid)
    return
  }
  await dropUnpublishedGeneration(coordinator, indexName, generation)
  throw interrupted(context)
}
