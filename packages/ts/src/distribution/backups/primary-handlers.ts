import { encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import { decode } from '../../serialization/msgpack'
import { getClusterIndexConfig, getIndexMetadata } from '../cluster/index-metadata'
import type { DataNodeHandlerDeps } from '../cluster-node/message-handler/types'
import { MAX_PARTITION_COUNT } from '../constants'
import type { PartitionAssignment } from '../coordinator/types'
import { isRecord, isValidInteger } from '../payload-guards'
import type { BackupPartitionResult, PartitionTaskPayload } from '../transport/backup-payloads'
import type { RespondFn, TransportMessage } from '../transport/types'
import { BACKUP_FILES_AT_ONCE } from './constants'
import { validateBackupName } from './keys'
import { backUpPartition } from './primary-backup'
import { restorePartition } from './primary-restore'
import { createPartitionTasks, type PartitionTasks } from './primary-tasks'
import { type BackupStore, readBackupManifest } from './store'
import { createTransferLimit, type TransferLimit } from './transfer-limit'

export interface BackupPrimary {
  store: BackupStore
  limit: TransferLimit
  backups: PartitionTasks<BackupPartitionResult>
  restores: PartitionTasks<undefined>
}

export function createBackupPrimary(store: BackupStore): BackupPrimary {
  return {
    store,
    limit: createTransferLimit(BACKUP_FILES_AT_ONCE),
    backups: createPartitionTasks<BackupPartitionResult>(),
    restores: createPartitionTasks<undefined>(),
  }
}

function invalid(what: string): NarsilError {
  return new NarsilError(ErrorCodes.CONFIG_INVALID, `Invalid backup partition message: ${what}`)
}

function readPayload(message: TransportMessage): PartitionTaskPayload {
  let decoded: unknown
  try {
    decoded = decode(message.payload)
  } catch (_) {
    decoded = null
  }
  if (!isRecord(decoded)) throw invalid('expected an object')
  const { jobId, indexName, partitionId } = decoded
  if (typeof jobId !== 'string' || jobId.length === 0) throw invalid('"jobId" must be a non-empty string')
  if (typeof indexName !== 'string' || indexName.length === 0) throw invalid('"indexName" must be a non-empty string')
  if (!isValidInteger(partitionId) || partitionId < 0 || partitionId >= MAX_PARTITION_COUNT) {
    throw invalid(`"partitionId" must be an integer from 0 to ${MAX_PARTITION_COUNT - 1}`)
  }
  return { jobId, backupName: validateBackupName(decoded.backupName), indexName, partitionId }
}

function requirePrimary(deps: DataNodeHandlerDeps): BackupPrimary {
  if (deps.backups === undefined) {
    throw new NarsilError(
      ErrorCodes.BACKUP_STORE_NOT_CONFIGURED,
      `Node '${deps.nodeId}' has no backup store, so it takes no part in a backup. Give every node the same \`backups\` setting.`,
      { nodeId: deps.nodeId },
    )
  }
  return deps.backups
}

async function localAssignment(deps: DataNodeHandlerDeps, payload: PartitionTaskPayload): Promise<PartitionAssignment> {
  const table = await deps.coordinator.getAllocation(payload.indexName)
  const assignment = table?.assignments.get(payload.partitionId)
  if (assignment === undefined || assignment.primary !== deps.nodeId) {
    throw new NarsilError(
      ErrorCodes.PARTITION_NOT_PRIMARY,
      `Node '${deps.nodeId}' is not primary for partition ${payload.partitionId} of index '${payload.indexName}'`,
      {
        indexName: payload.indexName,
        partitionId: payload.partitionId,
        primaryNodeId: assignment?.primary ?? null,
        localNodeId: deps.nodeId,
      },
    )
  }
  return assignment
}

async function reply(deps: DataNodeHandlerDeps, message: TransportMessage, respond: RespondFn, payload: unknown) {
  await respond({
    type: message.type,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode(payload, { ignoreUndefined: true }),
  })
}

export async function handleBackupPartition(message: TransportMessage, respond: RespondFn, deps: DataNodeHandlerDeps) {
  const payload = readPayload(message)
  const primary = requirePrimary(deps)
  await localAssignment(deps, payload)
  const state = primary.backups.poll(payload, () =>
    backUpPartition(
      { store: primary.store, limit: primary.limit, openPartition: deps.engine.openBackupPartition },
      payload.indexName,
      payload.partitionId,
    ),
  )
  await reply(deps, message, respond, state)
}

async function restoreOnePartition(
  deps: DataNodeHandlerDeps,
  primary: BackupPrimary,
  payload: PartitionTaskPayload,
  primaryTerm: number,
): Promise<undefined> {
  const { indexName: generation, partitionId } = payload
  const spoolDirectory = deps.snapshotSpoolDirectory
  const schema = await deps.coordinator.getSchema(generation)
  const metadata = await getIndexMetadata(deps.coordinator, generation)
  if (schema === null || metadata === null || spoolDirectory === undefined) {
    throw new NarsilError(
      ErrorCodes.INDEX_NOT_FOUND,
      `Index '${generation}' has no schema or metadata to restore into`,
      {
        indexName: generation,
      },
    )
  }
  const config = await getClusterIndexConfig(deps.coordinator, generation, schema)
  const backup = await readBackupManifest(primary.store, payload.backupName)
  const { engine, writeDeps } = deps
  await restorePartition(
    {
      store: primary.store,
      limit: primary.limit,
      spoolDirectory,
      restorePartition: (target, source) =>
        engine.restoreReplicationPartition(
          target.generation,
          target.partitionId,
          source,
          target.config,
          target.partitionCount,
        ),
      restartLog: (name, id, position) => engine.restartLocalLog(name, id, position),
      resetReplicationLog: (name, id, startSeqNo, term) => writeDeps.resetReplicationLog(name, id, startSeqNo, term),
    },
    backup,
    { generation, partitionId, primaryTerm, config, partitionCount: metadata.partitionCount },
  )
  return undefined
}

export async function handleRestorePartition(message: TransportMessage, respond: RespondFn, deps: DataNodeHandlerDeps) {
  const payload = readPayload(message)
  const primary = requirePrimary(deps)
  const assignment = await localAssignment(deps, payload)
  const state = primary.restores.poll(payload, () =>
    restoreOnePartition(deps, primary, payload, assignment.primaryTerm),
  )
  await reply(deps, message, respond, state)
}
