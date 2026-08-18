import type { DatasetId, DatasetLoadProgress, LoadDatasetRequest, LoadedIndex } from '@delali/narsil-example-shared'
import { deleteDisplayFields } from '@delali/narsil-example-shared/lib/display-fields'
import { deleteJudgedQuestions } from '@delali/narsil-example-shared/lib/judging'
import { useCallback, useEffect, useState } from 'react'
import { narsilWorker } from '#/worker/bridge'

export interface DatasetLoader {
  progressByDataset: ReadonlyMap<DatasetId, DatasetLoadProgress>
  isBusy: boolean
  load: (request: LoadDatasetRequest) => Promise<void>
  remove: (datasetId: DatasetId) => Promise<void>
}

function isRunning(progress: DatasetLoadProgress): boolean {
  return progress.phase === 'fetching' || progress.phase === 'indexing'
}

/**
 * Runs a dataset load in the worker and follows what it reports. The engine
 * writes each index through its persistence adapter, so a dataset loaded once
 * is back on the next visit without loading it again.
 */
export function useDatasetLoader(indexes: readonly LoadedIndex[], onIndexesChanged: () => void): DatasetLoader {
  const [progressByDataset, setProgressByDataset] = useState<ReadonlyMap<DatasetId, DatasetLoadProgress>>(new Map())

  useEffect(
    () =>
      narsilWorker.onProgress(progress => {
        setProgressByDataset(current => new Map(current).set(progress.datasetId, progress))
      }),
    [],
  )

  const load = useCallback(
    async (request: LoadDatasetRequest) => {
      setProgressByDataset(current =>
        new Map(current).set(request.datasetId, { datasetId: request.datasetId, phase: 'fetching' }),
      )
      try {
        await narsilWorker.call('loadDataset', [request])
        onIndexesChanged()
      } catch (err) {
        setProgressByDataset(current =>
          new Map(current).set(request.datasetId, {
            datasetId: request.datasetId,
            phase: 'error',
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    },
    [onIndexesChanged],
  )

  const remove = useCallback(
    async (datasetId: DatasetId) => {
      for (const index of indexes.filter(entry => entry.datasetId === datasetId)) {
        await narsilWorker.call('dropIndex', [index.name])
        deleteJudgedQuestions(index.name)
        deleteDisplayFields(index.name)
      }
      setProgressByDataset(current => {
        const next = new Map(current)
        next.delete(datasetId)
        return next
      })
      onIndexesChanged()
    },
    [indexes, onIndexesChanged],
  )

  let isBusy = false
  for (const progress of progressByDataset.values()) {
    if (isRunning(progress)) isBusy = true
  }

  return { progressByDataset, isBusy, load, remove }
}
