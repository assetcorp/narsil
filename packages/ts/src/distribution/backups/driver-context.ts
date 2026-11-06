import { ErrorCodes, NarsilError } from '../../errors'
import type { ClusterNodeConfig } from '../cluster-node/types'
import { type BackupJob, updateBackupJob } from './jobs'
import type { ClusterQueryHistory } from './query-history'
import type { BackupStore } from './store'

export interface BackupDriverContext {
  config: ClusterNodeConfig
  nodeId: string
  isActive: () => boolean
  onError: (error: unknown) => void
  queryHistory: ClusterQueryHistory | null
  store: BackupStore
  jobId: string
  job: BackupJob
}

export function stoppedDriving(context: BackupDriverContext): NarsilError {
  return new NarsilError(
    ErrorCodes.NODE_NOT_CONTROLLER,
    `Node '${context.nodeId}' stopped driving the ${context.job.kind} of backup '${context.job.backupName}', because it lost the controller lease or the job ended elsewhere`,
    { backupName: context.job.backupName, nodeId: context.nodeId, jobId: context.jobId },
  )
}

export function assertStillDriving(context: BackupDriverContext): void {
  if (!context.isActive()) throw stoppedDriving(context)
}

export function jobIndexNameOf(context: BackupDriverContext): string {
  const { indexName } = context.job
  if (indexName === undefined) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `The ${context.job.kind} job of backup '${context.job.backupName}' records no index name`,
      { backupName: context.job.backupName, jobId: context.jobId },
    )
  }
  return indexName
}

export async function recordJobChange(
  context: BackupDriverContext,
  change: (job: BackupJob) => BackupJob,
): Promise<void> {
  assertStillDriving(context)
  if (!(await updateBackupJob(context.config.coordinator, context.jobId, change))) throw stoppedDriving(context)
}

export function reportJobProgress(context: BackupDriverContext, done: number, total: number): Promise<void> {
  return recordJobChange(context, job => ({ ...job, partitionsDone: done, partitionsTotal: total }))
}
