import { ErrorCodes, NarsilError } from '../../errors'
import { pause } from '../cluster/rebalance/pause'
import type { ClusterCoordinator } from '../coordinator/types'
import { BACKUP_JOB_POLL_INTERVAL_MS } from './constants'
import { type BackupJob, readBackupJobs } from './jobs'
import type { BackupProgress } from './types'

export interface BackupJobWait {
  coordinator: ClusterCoordinator
  jobId: string
  guard: () => void
  onProgress?: (progress: BackupProgress) => void
}

function vanished(wait: BackupJobWait): NarsilError {
  return new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `The record of backup job '${wait.jobId}' disappeared before the job ended, so its outcome is unknown`,
    { jobId: wait.jobId },
  )
}

export async function awaitBackupJob(wait: BackupJobWait): Promise<BackupJob> {
  let reported = ''
  for (;;) {
    wait.guard()
    const job = (await readBackupJobs(wait.coordinator)).get(wait.jobId)
    if (job === undefined) throw vanished(wait)
    const progress: BackupProgress = { done: job.partitionsDone, total: job.partitionsTotal }
    const shown = `${progress.done}/${progress.total}`
    if (shown !== reported) {
      reported = shown
      wait.onProgress?.(progress)
    }
    if (job.status === 'done') return job
    if (job.status === 'failed') {
      const error = job.error ?? { code: ErrorCodes.ALLOCATION_FAILED, message: `The ${job.kind} job failed` }
      throw new NarsilError(error.code, error.message, {
        backupName: job.backupName,
        jobId: wait.jobId,
        ...(job.indexName === undefined ? {} : { indexName: job.indexName }),
      })
    }
    await pause(BACKUP_JOB_POLL_INTERVAL_MS)
  }
}
