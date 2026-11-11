import { ErrorCodes, NarsilError } from '../../../errors'
import { getIndexMetadata, type IndexMetadataRecord, readIndexMetadataSnapshot } from '../../cluster/index-metadata'
import { suggestionStateOfSettings } from '../../cluster/query-suggestion-settings'
import { servingNameOf } from '../../cluster-node/generation-routing'
import { isRecord, isValidInteger } from '../../payload-guards'
import type { BackupPartitionResult } from '../../transport/backup-payloads'
import { ClusterMessageTypes } from '../../transport/types'
import { BACKUP_PARTITIONS_AT_ONCE } from '../constants'
import { assertStillDriving, type BackupDriverContext, jobIndexNameOf, reportJobProgress } from '../driver-context'
import { firstUnstoredFile } from '../files'
import {
  type BackupManifest,
  type BackupPartition,
  encodeBackupManifest,
  readBackupPartition,
  readStoredFile,
  type StoredFile,
  storedFilesOf,
} from '../manifest'
import { drivePartitionTask, forEachPartition } from '../partition-exchange'
import { backUpQueryHistory, configWithSuggestionState } from '../query-history'
import { backupNameTaken, claimBackupStore, clusterUuidOf, holdsManifest } from '../store'

function unreadableResult(backupName: string, partitionId: number): NarsilError {
  return new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `The primary of partition ${partitionId} sent an unreadable result for backup '${backupName}'`,
    { backupName, partitionId },
  )
}

function readPartitionResult(
  value: unknown,
  backupName: string,
  partitionId: number,
  partitionCount: number,
): BackupPartitionResult {
  try {
    if (!isRecord(value) || !isValidInteger(value.filesStored) || !isValidInteger(value.bytesStored)) {
      throw unreadableResult(backupName, partitionId)
    }
    const partition = readBackupPartition(value.partition, backupName, partitionCount)
    if (partition.partitionId !== partitionId) throw unreadableResult(backupName, partitionId)
    const config = readStoredFile(value.config, backupName)
    return { partition, config, filesStored: value.filesStored, bytesStored: value.bytesStored }
  } catch (_) {
    throw unreadableResult(backupName, partitionId)
  }
}

function sameConfigOf(results: readonly BackupPartitionResult[], indexName: string): StoredFile {
  const [first] = results
  if (first === undefined || results.some(result => result.config.sha256 !== first.config.sha256)) {
    throw new NarsilError(
      ErrorCodes.ANALYSIS_CHANGE_NOT_READY,
      `The settings of index '${indexName}' changed while its partitions were backed up, so the backup stores no manifest`,
      { indexName },
    )
  }
  return first.config
}

async function backUpEveryPartition(
  context: BackupDriverContext,
  generation: string,
  partitionCount: number,
): Promise<BackupPartitionResult[]> {
  const { jobId, job } = context
  const results: BackupPartitionResult[] = new Array(partitionCount)
  let done = 0
  await forEachPartition(partitionCount, BACKUP_PARTITIONS_AT_ONCE, async partitionId => {
    const outcome = await drivePartitionTask(context, {
      type: ClusterMessageTypes.BACKUP_PARTITION,
      payload: { jobId, backupName: job.backupName, indexName: generation, partitionId },
      readResult: value => readPartitionResult(value, job.backupName, partitionId, partitionCount),
    })
    results[partitionId] = outcome.result
    done += 1
    await reportJobProgress(context, done, partitionCount)
  })
  return results
}

async function requireIndexMetadata(context: BackupDriverContext, indexName: string, generation: string) {
  const metadata: IndexMetadataRecord | null = await getIndexMetadata(context.config.coordinator, generation)
  if (metadata === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' does not exist in the cluster`, {
      indexName,
    })
  }
  return metadata
}

export interface BackupCreationRequest {
  takenBy: string | undefined
  queryHistory: boolean
}

export async function runBackupCreation(context: BackupDriverContext, request: BackupCreationRequest): Promise<void> {
  const { coordinator } = context.config
  const { store, job } = context
  const { takenBy } = request
  const indexName = jobIndexNameOf(context)
  const generation = await servingNameOf(coordinator, indexName)
  const named = (await readIndexMetadataSnapshot(coordinator, indexName))?.settings
  const syncEpoch = named?.sync?.enabled === true ? named.syncEpoch : undefined
  const metadata = await requireIndexMetadata(context, indexName, generation)
  const clusterUuid = await clusterUuidOf(coordinator)
  await reportJobProgress(context, 0, metadata.partitionCount)
  const results = await backUpEveryPartition(context, generation, metadata.partitionCount)
  const partitions: BackupPartition[] = results.map(result => result.partition)
  const config = await configWithSuggestionState(
    context,
    sameConfigOf(results, indexName),
    suggestionStateOfSettings(named),
  )
  const queryHistory = request.queryHistory ? await backUpQueryHistory(context, indexName) : undefined
  const manifest: BackupManifest = {
    name: job.backupName,
    clusterUuid,
    indexName,
    startedAt: job.startedAt,
    completedAt: Date.now(),
    partitionCount: metadata.partitionCount,
    ...(syncEpoch !== undefined ? { syncEpoch } : {}),
    ...(takenBy !== undefined ? { takenBy } : {}),
    replicationFactor: metadata.replicationFactor,
    constraints: metadata.constraints,
    config,
    ...(queryHistory === undefined ? {} : { queryHistory }),
    partitions,
  }
  const unstored = await firstUnstoredFile(store, storedFilesOf(manifest))
  if (unstored !== undefined) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The store lacks the file ${unstored.sha256} that backup '${job.backupName}' lists, so it stores no manifest`,
      { backupName: job.backupName, sha256: unstored.sha256 },
    )
  }
  assertStillDriving(context)
  await claimBackupStore(store, clusterUuid)
  if (await holdsManifest(store, job.backupName)) throw backupNameTaken(job.backupName)
  await reportJobProgress(context, metadata.partitionCount, metadata.partitionCount)
  await store.adapter.save(store.keys.manifest(job.backupName), await encodeBackupManifest(manifest))
}
