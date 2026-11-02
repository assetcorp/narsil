import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { IndexConfig } from '../../../types/schema'
import { HIDDEN_GENERATION_PREFIX } from '../../cluster/constants'
import { getIndexMetadata } from '../../cluster/index-metadata'
import { generationNameOf } from '../../cluster/rebalance/records'
import { requestReplicationFactor } from '../../cluster-node/replication-factor'
import type { AllocationConstraints } from '../../coordinator/types'
import { ClusterMessageTypes } from '../../transport/types'
import { BACKUP_PARTITIONS_AT_ONCE } from '../constants'
import {
  assertStillDriving,
  type BackupDriverContext,
  jobIndexNameOf,
  recordJobChange,
  reportJobProgress,
} from '../driver-context'
import { damagedFile, firstUnstoredFile, loadCheckedBytes } from '../files'
import { decodeBackupIndexConfig, writeRestoredMetadata } from '../index-config'
import { type BackupManifest, storedFilesOf } from '../manifest'
import { drivePartitionTask, forEachPartition } from '../partition-exchange'
import { dropUnpublishedGeneration, nameTaken, publishRestoredName } from '../restore-publish'

export interface RestoreRequest {
  manifest: BackupManifest
  replicationFactor?: number
  constraints?: AllocationConstraints
}

async function readRestorableConfig(context: BackupDriverContext, manifest: BackupManifest): Promise<IndexConfig> {
  const unstored = await firstUnstoredFile(context.store, storedFilesOf(manifest))
  if (unstored !== undefined) throw damagedFile(manifest.name, unstored, 'is missing from the store')
  const bytes = await loadCheckedBytes(context.store, manifest.config, manifest.name)
  return decodeBackupIndexConfig(bytes, manifest.name)
}

async function createGeneration(
  context: BackupDriverContext,
  config: IndexConfig,
  manifest: BackupManifest,
  generation: string,
  constraints: AllocationConstraints,
): Promise<void> {
  const { coordinator } = context.config
  const written = await writeRestoredMetadata(coordinator, config, {
    indexName: generation,
    indexUuid: generation.slice(HIDDEN_GENERATION_PREFIX.length),
    partitionCount: manifest.partitionCount,
    replicationFactor: 0,
    constraints,
  })
  if (!written) {
    throw new NarsilError(ErrorCodes.ALLOCATION_FAILED, `The restore found '${generation}' already written`, {
      generation,
    })
  }
  assertStillDriving(context)
  await coordinator.putSchema(generation, config.schema)
}

async function restoreEveryPartition(
  context: BackupDriverContext,
  generation: string,
  manifest: BackupManifest,
): Promise<Map<number, number>> {
  const terms = new Map<number, number>()
  let done = 0
  await forEachPartition(manifest.partitionCount, BACKUP_PARTITIONS_AT_ONCE, async partitionId => {
    const outcome = await drivePartitionTask(context, {
      type: ClusterMessageTypes.RESTORE_PARTITION,
      payload: { jobId: context.jobId, backupName: manifest.name, indexName: generation, partitionId },
      readResult: () => undefined,
    })
    terms.set(partitionId, outcome.primaryTerm)
    done += 1
    await reportJobProgress(context, done, manifest.partitionCount)
  })
  return terms
}

async function requireUnmovedPrimaries(
  context: BackupDriverContext,
  generation: string,
  terms: Map<number, number>,
): Promise<void> {
  const table = await context.config.coordinator.getAllocation(generation)
  for (const [partitionId, term] of terms) {
    if (table?.assignments.get(partitionId)?.primaryTerm === term) continue
    throw new NarsilError(
      ErrorCodes.ALLOCATION_FAILED,
      `The primary of restored partition ${partitionId} changed before the index was ready, so the restore creates no index`,
      { generation, partitionId },
    )
  }
}

async function restoreIntoGeneration(
  context: BackupDriverContext,
  request: RestoreRequest,
  config: IndexConfig,
  generation: string,
  constraints: AllocationConstraints,
): Promise<void> {
  const { manifest } = request
  await createGeneration(context, config, manifest, generation, constraints)
  const terms = await restoreEveryPartition(context, generation, manifest)
  const replicationFactor = request.replicationFactor ?? manifest.replicationFactor
  if (replicationFactor > 0) {
    assertStillDriving(context)
    await requestReplicationFactor(context.config, context.nodeId, generation, replicationFactor)
  }
  await requireUnmovedPrimaries(context, generation, terms)
}

async function writeNameMetadata(
  context: BackupDriverContext,
  config: IndexConfig,
  request: RestoreRequest,
  constraints: AllocationConstraints,
  indexUuid: string,
): Promise<boolean> {
  const indexName = jobIndexNameOf(context)
  const { coordinator } = context.config
  try {
    return await writeRestoredMetadata(coordinator, config, {
      indexName,
      indexUuid,
      partitionCount: request.manifest.partitionCount,
      replicationFactor: request.replicationFactor ?? request.manifest.replicationFactor,
      constraints,
    })
  } catch (error) {
    const written = await getIndexMetadata(coordinator, indexName).catch(() => null)
    if (written?.indexUuid === indexUuid) return true
    throw error
  }
}

export async function runBackupRestore(context: BackupDriverContext, request: RestoreRequest): Promise<void> {
  const { coordinator } = context.config
  const indexName = jobIndexNameOf(context)
  const { manifest } = request
  const config = await readRestorableConfig(context, manifest)
  const constraints = request.constraints ?? manifest.constraints
  const generation = generationNameOf(generateId())
  const nameIndexUuid = generateId()
  await recordJobChange(context, job => ({ ...job, generation, partitionsTotal: manifest.partitionCount }))
  let published = false
  try {
    await restoreIntoGeneration(context, request, config, generation, constraints)
    await recordJobChange(context, job => ({ ...job, nameIndexUuid }))
    assertStillDriving(context)
    if (!(await writeNameMetadata(context, config, request, constraints, nameIndexUuid))) throw nameTaken(indexName)
    published = true
  } finally {
    if (!published) await dropUnpublishedGeneration(coordinator, indexName, generation).catch(context.onError)
  }
  await publishRestoredName(context, generation, nameIndexUuid)
}
