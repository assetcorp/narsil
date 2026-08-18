import type {
  IndexInfo,
  IndexStats,
  ListParams,
  ListResult,
  MemoryStats,
  NarsilError,
  PartitionStatsResult,
  QueryParams,
  QueryResult,
  SuggestParams,
  SuggestResult,
  VectorMaintenanceResult,
} from '@delali/narsil'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { narsilWorker } from './bridge'
import type { WorkerArgs, WorkerMethod, WorkerResult } from './protocol'

/**
 * What every read hook here answers with. It is the shape
 * `@delali/narsil/react` gives a server-backed app, so the panels read the
 * same fields whichever example they are rendered in.
 */
export interface WorkerReadState<T> {
  data: T | undefined
  error: NarsilError | undefined
  isLoading: boolean
  isFetching: boolean
  refresh: () => void
}

interface ReadOptions {
  enabled?: boolean
  keepPreviousData?: boolean
}

function useWorkerCall<K extends WorkerMethod>(
  method: K,
  args: WorkerArgs<K> | null,
  options?: ReadOptions,
): WorkerReadState<WorkerResult<K>> {
  const enabled = (options?.enabled ?? true) && args !== null
  const keepPreviousData = options?.keepPreviousData ?? false
  const key = useMemo(() => (args === null ? null : JSON.stringify([method, args])), [method, args])

  const [data, setData] = useState<WorkerResult<K> | undefined>(undefined)
  const [error, setError] = useState<NarsilError | undefined>(undefined)
  const [isFetching, setIsFetching] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const latestArgs = useRef(args)
  latestArgs.current = args

  const runKey = key === null ? null : `${attempt}:${key}`

  useEffect(() => {
    if (!enabled || runKey === null) {
      setIsFetching(false)
      return
    }

    const controller = new AbortController()
    setIsFetching(true)
    if (!keepPreviousData) setData(undefined)

    narsilWorker
      .call(method, latestArgs.current as WorkerArgs<K>, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return
        setData(result)
        setError(undefined)
      })
      .catch((err: NarsilError) => {
        if (controller.signal.aborted) return
        setError(err)
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsFetching(false)
      })

    return () => {
      controller.abort()
    }
  }, [method, runKey, enabled, keepPreviousData])

  const refresh = useCallback(() => {
    setAttempt(current => current + 1)
  }, [])

  return useMemo(
    () => ({
      data: enabled ? data : undefined,
      error: enabled ? error : undefined,
      isLoading: enabled && isFetching && data === undefined,
      isFetching: enabled && isFetching,
      refresh,
    }),
    [enabled, data, error, isFetching, refresh],
  )
}

export function useWorkerIndexes(): WorkerReadState<IndexInfo[]> {
  const args = useMemo(() => [] as [], [])
  return useWorkerCall('listIndexes', args)
}

export function useWorkerQuery(
  indexName: string | null,
  params: QueryParams,
  options?: ReadOptions,
): WorkerReadState<QueryResult> {
  const args = useMemo(
    () => (indexName === null ? null : ([indexName, params] as [string, QueryParams])),
    [indexName, params],
  )
  return useWorkerCall('query', args, options)
}

export function useWorkerSuggest(
  indexName: string | null,
  params: SuggestParams,
  options?: ReadOptions,
): WorkerReadState<SuggestResult> {
  const args = useMemo(
    () => (indexName === null ? null : ([indexName, params] as [string, SuggestParams])),
    [indexName, params],
  )
  return useWorkerCall('suggest', args, options)
}

export function useWorkerDocuments(
  indexName: string | null,
  params: ListParams,
  options?: ReadOptions,
): WorkerReadState<ListResult> {
  const args = useMemo(
    () => (indexName === null ? null : ([indexName, params] as [string, ListParams])),
    [indexName, params],
  )
  return useWorkerCall('listDocuments', args, options)
}

export function useWorkerStats(indexName: string | null): WorkerReadState<IndexStats> {
  const args = useMemo(() => (indexName === null ? null : ([indexName] as [string])), [indexName])
  return useWorkerCall('getStats', args)
}

export function useWorkerPartitions(indexName: string | null): WorkerReadState<PartitionStatsResult[]> {
  const args = useMemo(() => (indexName === null ? null : ([indexName] as [string])), [indexName])
  return useWorkerCall('getPartitionStats', args)
}

export function useWorkerVectorFields(indexName: string | null): WorkerReadState<VectorMaintenanceResult[]> {
  const args = useMemo(() => (indexName === null ? null : ([indexName] as [string])), [indexName])
  return useWorkerCall('vectorMaintenanceStatus', args)
}

export function useWorkerMemory(enabled: boolean): WorkerReadState<MemoryStats> {
  const args = useMemo(() => [] as [], [])
  return useWorkerCall('getMemoryStats', args, { enabled })
}
