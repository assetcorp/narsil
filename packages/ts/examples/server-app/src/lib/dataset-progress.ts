import type { TaskRecord } from '@delali/narsil/client'
import type { DatasetId } from '@delali/narsil-example-shared/manifest'
import type { DatasetLoadProgress } from '@delali/narsil-example-shared/types'
import { inferDatasetId } from '@delali/narsil-example-shared/types'

export function isRunningTask(task: TaskRecord): boolean {
  return task.status === 'queued' || task.status === 'running'
}

/** Reads one import task as the progress a dataset card shows. */
export function taskProgress(task: TaskRecord): DatasetLoadProgress {
  const datasetId = inferDatasetId(task.indexName)
  if (task.status === 'failed') {
    return { datasetId, phase: 'error', error: task.error?.message ?? 'The load failed' }
  }
  if (task.status === 'cancelled') {
    return { datasetId, phase: 'error', error: 'The load was stopped' }
  }
  if (task.status === 'succeeded') {
    return { datasetId, phase: 'complete', indexedDocs: task.result?.indexed }
  }
  return {
    datasetId,
    phase: 'indexing',
    indexedDocs: task.progress?.indexed,
    loadedBytes: task.progress?.bytesProcessed,
    totalBytes: task.progress?.bytesTotal,
  }
}

/**
 * Picks the task each dataset card follows: the one still running when there
 * is one, because a dataset that builds several indexes has a task each, and
 * otherwise the one that finished last.
 */
export function taskByDataset(tasks: readonly TaskRecord[]): Map<DatasetId, TaskRecord> {
  const chosen = new Map<DatasetId, TaskRecord>()
  for (const task of tasks) {
    const datasetId = inferDatasetId(task.indexName)
    const held = chosen.get(datasetId)
    if (held === undefined) {
      chosen.set(datasetId, task)
      continue
    }
    if (isRunningTask(held) && !isRunningTask(task)) continue
    if (!isRunningTask(held) && isRunningTask(task)) {
      chosen.set(datasetId, task)
      continue
    }
    if (task.createdAt > held.createdAt) chosen.set(datasetId, task)
  }
  return chosen
}
