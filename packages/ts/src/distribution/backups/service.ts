import { ErrorCodes, NarsilError } from '../../errors'
import type { ControllerMessageHandler } from '../cluster/controller/types'
import type { ClusterNamespace, ClusterNodeConfig } from '../cluster-node/types'
import { BACKUP_SWEEP_INTERVAL_MS } from './constants'
import { type BackupControllerDeps, createBackupControllerHandler, driveBackupJob } from './controller-messages'
import { runBackupDeletion } from './drivers/delete'
import { type BackupJob, finishBackupJob, readBackupJobs } from './jobs'
import { type BackupPrimary, createBackupPrimary } from './primary-handlers'
import type { ClusterQueryHistory } from './query-history'
import { requestBackup, requestBackupDeletion, requestRestore, requireBackupStore } from './requests'
import { resumeRestore } from './restore-publish'
import { type BackupStore, listBackups, openBackupStore } from './store'

export interface BackupServiceDeps {
  config: ClusterNodeConfig
  nodeId: string
  guard: () => void
  isController: () => boolean
  onError: (error: unknown) => void
  queryHistory: ClusterQueryHistory | null
}

export interface BackupService {
  namespace: Pick<ClusterNamespace, 'createBackup' | 'restoreBackup' | 'listBackups' | 'deleteBackup'>
  controllerMessages: ControllerMessageHandler
  primary: BackupPrimary | undefined
  start(): void
  stop(): void
}

function abandonedBackup(jobId: string, job: BackupJob): NarsilError {
  return new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `The controller that ran backup '${job.backupName}' stopped before it finished, so the backup stored no manifest`,
    { backupName: job.backupName, jobId },
  )
}

function takeOverJob(deps: BackupControllerDeps, store: BackupStore, jobId: string, job: BackupJob): Promise<void> {
  if (job.kind === 'backup') return finishBackupJob(deps.config.coordinator, jobId, abandonedBackup(jobId, job))
  void driveBackupJob(deps, store, jobId, job, job.kind === 'delete' ? runBackupDeletion : resumeRestore)
  return Promise.resolve()
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
  const store = deps.config.backups === undefined ? null : openBackupStore(deps.config.backups)
  const requestDeps = { config: deps.config, nodeId: deps.nodeId, guard: deps.guard, store }
  const controllerDeps: BackupControllerDeps = {
    config: deps.config,
    nodeId: deps.nodeId,
    isActive: deps.isController,
    onError: deps.onError,
    queryHistory: deps.queryHistory,
    store,
    driving: new Set(),
  }
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  let sweeping = false

  async function sweep(): Promise<void> {
    if (sweeping || store === null || !deps.isController()) return
    sweeping = true
    try {
      for (const [jobId, job] of await readBackupJobs(deps.config.coordinator)) {
        if (job.status !== 'running' || controllerDeps.driving.has(jobId) || !deps.isController()) continue
        await takeOverJob(controllerDeps, store, jobId, job)
      }
    } catch (error) {
      deps.onError(error)
    } finally {
      sweeping = false
    }
  }

  return {
    namespace: {
      createBackup: (indexName, backupName, options) => requestBackup(requestDeps, indexName, backupName, options),
      restoreBackup: (backupName, options) => requestRestore(requestDeps, backupName, options),
      deleteBackup: (backupName, options) => requestBackupDeletion(requestDeps, backupName, options),
      listBackups: () => listBackups(requireBackupStore(store)),
    },
    controllerMessages: createBackupControllerHandler(controllerDeps),
    primary: store === null ? undefined : createBackupPrimary(store),
    start() {
      if (sweepTimer !== null) return
      void sweep()
      sweepTimer = setInterval(() => void sweep(), BACKUP_SWEEP_INTERVAL_MS)
      sweepTimer.unref?.()
    },
    stop() {
      if (sweepTimer !== null) clearInterval(sweepTimer)
      sweepTimer = null
    },
  }
}
