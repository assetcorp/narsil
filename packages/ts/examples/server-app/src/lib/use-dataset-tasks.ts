import type { TaskRecord } from '@delali/narsil/react'
import { useNarsilClient, useTasks } from '@delali/narsil/react'
import type { DatasetId, DatasetLoadProgress, LoadDatasetRequest, LoadedIndex } from '@delali/narsil-example-shared'
import { deleteDisplayFields } from '@delali/narsil-example-shared/lib/display-fields'
import { deleteJudgedQuestions } from '@delali/narsil-example-shared/lib/judging'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { startDatasetLoadFn } from '#/lib/dataset-load'
import { isRunningTask, taskByDataset, taskProgress } from '#/lib/dataset-progress'

const RUNNING_POLL_MS = 500
const IDLE_POLL_MS = 5_000
const TASK_PAGE_SIZE = 50
const NO_TASKS: TaskRecord[] = []

export interface DatasetTasks {
  progressByDataset: ReadonlyMap<DatasetId, DatasetLoadProgress>
  isBusy: boolean
  start: (request: LoadDatasetRequest) => Promise<void>
  cancel: (datasetId: DatasetId) => void
  remove: (datasetId: DatasetId) => Promise<void>
}

/**
 * Follows every import the search server is running and turns each one into
 * the progress a dataset card reads. The tasks live on that server, so a load
 * started before this page opened is picked up here, and one started here
 * carries on when the page closes.
 */
export function useDatasetTasks(indexes: readonly LoadedIndex[], onIndexesChanged: () => void): DatasetTasks {
  const client = useNarsilClient()
  const [failures, setFailures] = useState<ReadonlyMap<DatasetId, string>>(new Map())
  const [pollIntervalMs, setPollIntervalMs] = useState(IDLE_POLL_MS)

  const query = useMemo(() => ({ type: ['import' as const], limit: TASK_PAGE_SIZE }), [])
  const options = useMemo(() => ({ refreshIntervalMs: pollIntervalMs }), [pollIntervalMs])
  const tasks = useTasks(query, options)

  const records = tasks.data?.tasks ?? NO_TASKS
  const followed = useMemo(() => taskByDataset(records), [records])
  const isBusy = records.some(isRunningTask)

  const wantedInterval = isBusy ? RUNNING_POLL_MS : IDLE_POLL_MS
  if (pollIntervalMs !== wantedInterval) setPollIntervalMs(wantedInterval)

  const settledCount = records.filter(task => !isRunningTask(task)).length
  useEffect(() => {
    if (settledCount > 0) onIndexesChanged()
  }, [settledCount, onIndexesChanged])

  const progressByDataset = useMemo(() => {
    const progress = new Map<DatasetId, DatasetLoadProgress>()
    for (const [datasetId, task] of followed) progress.set(datasetId, taskProgress(task))
    for (const [datasetId, message] of failures) progress.set(datasetId, { datasetId, phase: 'error', error: message })
    return progress
  }, [followed, failures])

  const start = useCallback(
    async (request: LoadDatasetRequest) => {
      setFailures(previous => {
        if (!previous.has(request.datasetId)) return previous
        const next = new Map(previous)
        next.delete(request.datasetId)
        return next
      })
      try {
        await startDatasetLoadFn({ data: request })
      } catch (err) {
        setFailures(previous =>
          new Map(previous).set(request.datasetId, err instanceof Error ? err.message : String(err)),
        )
      }
      tasks.refresh()
      onIndexesChanged()
    },
    [tasks.refresh, onIndexesChanged],
  )

  const cancel = useCallback(
    (datasetId: DatasetId) => {
      const task = followed.get(datasetId)
      if (task === undefined || !isRunningTask(task)) return
      void client.cancelTask(task.id).catch(() => undefined)
    },
    [client, followed],
  )

  const remove = useCallback(
    async (datasetId: DatasetId) => {
      for (const index of indexes.filter(entry => entry.datasetId === datasetId)) {
        await client.dropIndex(index.name)
        deleteJudgedQuestions(index.name)
        deleteDisplayFields(index.name)
      }
      onIndexesChanged()
    },
    [client, indexes, onIndexesChanged],
  )

  return { progressByDataset, isBusy, start, cancel, remove }
}
