import { ErrorCodes, NarsilError } from '../../errors'
import { CONTROLLER_LEASE_KEY } from '../cluster/controller/types'
import { exchangeRebalanceMessage } from '../cluster/rebalance/reply'
import { resolveNodeTargets } from '../cluster-node/node-messaging'
import type { ClusterNodeConfig } from '../cluster-node/types'
import type {
  BackupDeleteRequestPayload,
  BackupRequestPayload,
  BackupRestoreRequestPayload,
} from '../transport/backup-payloads'
import { ClusterMessageTypes } from '../transport/types'
import { requireRestorableIndexName } from './controller-checks'
import { awaitBackupJob } from './job-wait'
import type { BackupJobKind } from './jobs'
import { validateBackupName } from './keys'
import { type BackupStore, readBackupManifest, summaryOf } from './store'
import type { BackupOperationOptions, BackupSummary, RestoreBackupOptions } from './types'

export interface BackupRequestDeps {
  config: ClusterNodeConfig
  nodeId: string
  guard: () => void
  store: BackupStore | null
}

export function requireBackupStore(store: BackupStore | null): BackupStore {
  if (store === null) {
    throw new NarsilError(
      ErrorCodes.BACKUP_STORE_NOT_CONFIGURED,
      'This node has no backup store, so it takes no backup call. Set `backups` in the cluster node config.',
    )
  }
  return store
}

function requireIndexName(indexName: unknown): string {
  if (typeof indexName !== 'string') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'An index name is a string', { indexName: typeof indexName })
  }
  return requireRestorableIndexName(indexName)
}

interface JobRequest {
  kind: BackupJobKind
  type: string
  backupName: string
  payload: BackupRequestPayload | BackupRestoreRequestPayload | BackupDeleteRequestPayload
  details: Record<string, unknown>
}

async function runJob(deps: BackupRequestDeps, request: JobRequest, options?: BackupOperationOptions): Promise<void> {
  deps.guard()
  const controllerNodeId = await deps.config.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
  if (controllerNodeId === null) {
    throw new NarsilError(
      ErrorCodes.NODE_NOT_CONTROLLER,
      `No node holds the controller lease, so the ${request.kind} of backup '${request.backupName}' cannot start`,
      request.details,
    )
  }
  const reply = await exchangeRebalanceMessage({
    transport: deps.config.transport,
    senderId: deps.nodeId,
    targets: await resolveNodeTargets(deps.config, controllerNodeId),
    type: request.type,
    payload: request.payload,
    failureMessage: `The controller '${controllerNodeId}' did not answer the ${request.kind} of backup '${request.backupName}'`,
    details: { ...request.details, controllerNodeId },
  })
  if (typeof reply.jobId !== 'string' || reply.jobId.length === 0) {
    throw new NarsilError(
      ErrorCodes.ALLOCATION_FAILED,
      `The controller sent an unreadable answer to the ${request.kind} of backup '${request.backupName}'`,
      { ...request.details, controllerNodeId },
    )
  }
  await awaitBackupJob({
    coordinator: deps.config.coordinator,
    jobId: reply.jobId,
    guard: deps.guard,
    onProgress: options?.onProgress,
  })
}

export async function requestBackup(
  deps: BackupRequestDeps,
  indexName: string,
  backupName: string,
  options?: BackupOperationOptions,
): Promise<BackupSummary> {
  const store = requireBackupStore(deps.store)
  const payload: BackupRequestPayload = {
    backupName: validateBackupName(backupName),
    indexName: requireIndexName(indexName),
  }
  await runJob(
    deps,
    { kind: 'backup', type: ClusterMessageTypes.BACKUP, backupName, payload, details: { backupName, indexName } },
    options,
  )
  return summaryOf(await readBackupManifest(store, backupName))
}

export async function requestRestore(
  deps: BackupRequestDeps,
  backupName: string,
  options: RestoreBackupOptions,
): Promise<BackupSummary> {
  const store = requireBackupStore(deps.store)
  const payload: BackupRestoreRequestPayload = {
    backupName: validateBackupName(backupName),
    indexName: requireIndexName(options.indexName),
    ...(options.replicationFactor === undefined ? {} : { replicationFactor: options.replicationFactor }),
    ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
  }
  const details = { backupName, indexName: payload.indexName }
  await runJob(
    deps,
    { kind: 'restore', type: ClusterMessageTypes.BACKUP_RESTORE, backupName, payload, details },
    options,
  )
  return summaryOf(await readBackupManifest(store, backupName))
}

export async function requestBackupDeletion(
  deps: BackupRequestDeps,
  backupName: string,
  options?: BackupOperationOptions,
): Promise<void> {
  requireBackupStore(deps.store)
  const payload: BackupDeleteRequestPayload = { backupName: validateBackupName(backupName) }
  await runJob(
    deps,
    { kind: 'delete', type: ClusterMessageTypes.BACKUP_DELETE, backupName, payload, details: { backupName } },
    options,
  )
}
