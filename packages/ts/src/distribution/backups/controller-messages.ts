import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../errors'
import type { ControllerMessageHandler } from '../cluster/controller/types'
import { encodeRebalanceRefusal } from '../cluster/rebalance/reply'
import type { ClusterNodeConfig } from '../cluster-node/types'
import { isRecord } from '../payload-guards'
import type { BackupRequestResultPayload } from '../transport/backup-payloads'
import type { RespondFn, TransportMessage } from '../transport/types'
import { ClusterMessageTypes } from '../transport/types'
import { admitBackup, admitDeletion, admitRestore } from './controller-checks'
import type { BackupDriverContext } from './driver-context'
import { runBackupCreation } from './drivers/create'
import { runBackupDeletion } from './drivers/delete'
import { type RestoreRequest, runBackupRestore } from './drivers/restore'
import { type BackupJob, type BackupJobKind, finishBackupJob, startBackupJob } from './jobs'
import { validateBackupName } from './keys'
import { type RestorePlacement, readRestorePlacement } from './restore-options'
import type { BackupStore } from './store'

export interface BackupControllerDeps {
  config: ClusterNodeConfig
  nodeId: string
  isActive: () => boolean
  onError: (error: unknown) => void
  store: BackupStore | null
  driving: Set<string>
}

const KIND_BY_TYPE: ReadonlyMap<string, BackupJobKind> = new Map([
  [ClusterMessageTypes.BACKUP, 'backup'],
  [ClusterMessageTypes.BACKUP_RESTORE, 'restore'],
  [ClusterMessageTypes.BACKUP_DELETE, 'delete'],
])

function malformed(kind: BackupJobKind, reason: string): NarsilError {
  return new NarsilError(ErrorCodes.CONFIG_INVALID, `The ${kind} request for a backup is malformed: ${reason}`, {
    kind,
  })
}

function decodeRequest(kind: BackupJobKind, message: TransportMessage): Record<string, unknown> {
  let decoded: unknown
  try {
    decoded = decode(message.payload)
  } catch (_) {
    throw malformed(kind, 'the payload is not MessagePack')
  }
  if (!isRecord(decoded)) throw malformed(kind, 'expected an object')
  return decoded
}

function indexNameOf(kind: BackupJobKind, request: Record<string, unknown>): string {
  if (typeof request.indexName !== 'string' || request.indexName.length === 0) {
    throw malformed(kind, '"indexName" must be a non-empty string')
  }
  return request.indexName
}

function restoreOptionsOf(request: Record<string, unknown>): RestorePlacement {
  const placement = readRestorePlacement(request)
  if (typeof placement === 'string') throw malformed('restore', placement)
  return placement
}

function requireStore(deps: BackupControllerDeps): BackupStore {
  if (deps.store === null) {
    throw new NarsilError(
      ErrorCodes.BACKUP_STORE_NOT_CONFIGURED,
      `The controller '${deps.nodeId}' has no backup store. Give every node the same \`backups\` setting.`,
      { nodeId: deps.nodeId },
    )
  }
  return deps.store
}

export function driveBackupJob(
  deps: BackupControllerDeps,
  store: BackupStore,
  jobId: string,
  job: BackupJob,
  run: (context: BackupDriverContext) => Promise<void>,
): void {
  deps.driving.add(jobId)
  const context: BackupDriverContext = {
    config: deps.config,
    nodeId: deps.nodeId,
    isActive: deps.isActive,
    onError: deps.onError,
    store,
    jobId,
    job,
  }
  void run(context)
    .then(
      () => finishBackupJob(deps.config.coordinator, jobId, null),
      error => (deps.isActive() ? finishBackupJob(deps.config.coordinator, jobId, error) : deps.onError(error)),
    )
    .catch(deps.onError)
    .finally(() => deps.driving.delete(jobId))
}

async function startJob(
  deps: BackupControllerDeps,
  store: BackupStore,
  job: BackupJob,
  run: (context: BackupDriverContext) => Promise<void>,
): Promise<BackupRequestResultPayload> {
  const jobId = generateId()
  deps.driving.add(jobId)
  try {
    await startBackupJob(deps.config.coordinator, jobId, job)
  } catch (error) {
    deps.driving.delete(jobId)
    throw error
  }
  driveBackupJob(deps, store, jobId, job, run)
  return { jobId }
}

function runningJob(kind: BackupJobKind, backupName: string, indexName?: string): BackupJob {
  return {
    kind,
    backupName,
    ...(indexName === undefined ? {} : { indexName }),
    status: 'running',
    partitionsDone: 0,
    partitionsTotal: 0,
    startedAt: Date.now(),
  }
}

async function acceptRequest(
  deps: BackupControllerDeps,
  kind: BackupJobKind,
  message: TransportMessage,
): Promise<BackupRequestResultPayload> {
  if (!deps.isActive()) {
    throw new NarsilError(ErrorCodes.NODE_NOT_CONTROLLER, `Node '${deps.nodeId}' does not hold the controller lease`, {
      nodeId: deps.nodeId,
    })
  }
  const store = requireStore(deps)
  const request = decodeRequest(kind, message)
  const backupName = validateBackupName(request.backupName)
  const { coordinator } = deps.config
  if (kind === 'backup') {
    const indexName = indexNameOf(kind, request)
    await admitBackup(coordinator, store, backupName, indexName)
    return startJob(deps, store, runningJob(kind, backupName, indexName), runBackupCreation)
  }
  if (kind === 'restore') {
    const indexName = indexNameOf(kind, request)
    const options = restoreOptionsOf(request)
    const manifest = await admitRestore(coordinator, store, backupName, indexName)
    const restore: RestoreRequest = { manifest, ...options }
    return startJob(deps, store, runningJob(kind, backupName, indexName), context => runBackupRestore(context, restore))
  }
  await admitDeletion(coordinator, store, backupName)
  return startJob(deps, store, runningJob(kind, backupName), runBackupDeletion)
}

function answer(deps: BackupControllerDeps, kind: BackupJobKind, message: TransportMessage, respond: RespondFn) {
  acceptRequest(deps, kind, message).then(
    result =>
      respond({
        type: message.type,
        sourceId: deps.nodeId,
        requestId: message.requestId,
        payload: encode(result),
      }).catch(deps.onError),
    error =>
      respond({
        type: `${message.type}.error`,
        sourceId: deps.nodeId,
        requestId: message.requestId,
        payload: encodeRebalanceRefusal(error),
      }).catch(deps.onError),
  )
}

export function createBackupControllerHandler(deps: BackupControllerDeps): ControllerMessageHandler {
  return (message, respond) => {
    const kind = KIND_BY_TYPE.get(message.type)
    if (kind === undefined) return false
    answer(deps, kind, message, respond)
    return true
  }
}
