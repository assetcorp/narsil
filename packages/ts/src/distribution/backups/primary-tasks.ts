import type { PartitionTaskReply } from '../transport/backup-payloads'
import { BACKUP_PARTITION_RESULT_RETENTION_MS } from './constants'
import { backupFailureOf } from './jobs'

interface TrackedTask<T> {
  settled: boolean
  result: T | undefined
  error: { code: string; message: string } | undefined
  finishedAt: number
}

export interface PartitionTaskRef {
  jobId: string
  indexName: string
  partitionId: number
}

export interface PartitionTasks<T> {
  poll(ref: PartitionTaskRef, start: () => Promise<T>): PartitionTaskReply<T>
  clear(): void
}

function keyOf(ref: PartitionTaskRef): string {
  return `${ref.jobId}\u0000${ref.indexName}\u0000${ref.partitionId}`
}

export function createPartitionTasks<T>(): PartitionTasks<T> {
  const tasks = new Map<string, TrackedTask<T>>()

  function dropExpired(now: number): void {
    for (const [key, task] of tasks) {
      if (task.settled && now - task.finishedAt > BACKUP_PARTITION_RESULT_RETENTION_MS) tasks.delete(key)
    }
  }

  return {
    poll(ref, start) {
      dropExpired(Date.now())
      const key = keyOf(ref)
      const base = { jobId: ref.jobId, partitionId: ref.partitionId }
      const known = tasks.get(key)
      if (known === undefined) {
        const task: TrackedTask<T> = { settled: false, result: undefined, error: undefined, finishedAt: 0 }
        tasks.set(key, task)
        start().then(
          result => {
            task.result = result
            task.settled = true
            task.finishedAt = Date.now()
          },
          error => {
            task.error = backupFailureOf(error)
            task.settled = true
            task.finishedAt = Date.now()
          },
        )
        return { ...base, status: 'running' }
      }
      if (!known.settled) return { ...base, status: 'running' }
      if (known.error !== undefined) {
        tasks.delete(key)
        return { ...base, status: 'failed', error: known.error }
      }
      return { ...base, status: 'done', ...(known.result === undefined ? {} : { result: known.result }) }
    },
    clear() {
      tasks.clear()
    },
  }
}
