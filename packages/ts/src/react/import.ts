import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { ImportSource, RequestOptions } from '../client'
import { isNarsilError, NarsilError, ServerErrorCodes } from '../errors'
import type { ImportResult, TaskProgress, TaskRecord } from '../server/types'
import { DEFAULT_TASK_POLL_INTERVAL_MS } from './constants'
import { useServerClient } from './context'
import { asNarsilError } from './failure'
import { type NarsilRequestSettings, requestOf } from './options'
import { usePolling } from './poll'
import { isTerminalTask, pollInterval } from './task-state'

/**
 * These settings control how {@link useImport} starts a load and polls its
 * progress.
 *
 * @public
 */
export interface NarsilImportOptions extends NarsilRequestSettings {
  /** The hook asks the server for the progress of the load at this interval in
   * milliseconds, which is 250 unless you set another value. That default
   * matches the interval at which the server updates the figures. While the
   * server is failing, the hook waits five seconds between attempts. */
  pollIntervalMs?: number
  /** The hook calls this function once the load reaches a final status,
   * whatever that status is. */
  onSettled?: (record: TaskRecord) => void
}

/**
 * These fields report where a load from {@link useImport} stands, together with
 * the functions that control the load.
 *
 * @public
 */
export interface NarsilImportState {
  /**
   * This function sends a corpus, then returns once the server has received the
   * body and started the task. The server loads the documents after that, while
   * the hook polls the task.
   *
   * @param source - These are the documents, or the NDJSON text that you
   * already hold.
   * @returns This is the record of the task that the server started.
   * @throws A `NarsilError` under the code that the server sent, or with
   * `NOT_FOUND` when the server is older than the asynchronous import.
   */
  start: (source: ImportSource) => Promise<TaskRecord>
  /** This function asks the load in progress to stop. While the browser is
   * still sending the corpus, a call aborts the upload; after that, a call asks
   * the server to stop the task. The server stops between batches, so the
   * documents that it has already written stay in the index. */
  cancel: () => void
  /** This function clears the record and the failure, so that the hook is
   * ready for another load. */
  reset: () => void
  /** This is the record of the task, from the moment that the server starts
   * it. */
  task: TaskRecord | undefined
  /** This is the progress of the load, which suits a progress bar. */
  progress: TaskProgress | undefined
  /** This counts the documents that the server indexed and refused, which the
   * hook sets once the load finishes. */
  result: ImportResult | undefined
  /** This is the failure that stopped the load, or the failure that ended the
   * last poll. */
  error: NarsilError | undefined
  /** This is true from the call to `start` until the load reaches a final
   * status. */
  isImporting: boolean
}

interface ImportProgress {
  task: TaskRecord | undefined
  error: NarsilError | undefined
  starting: boolean
}

const NOTHING: ImportProgress = { task: undefined, error: undefined, starting: false }

/**
 * This hook loads a corpus into an index on a server and reports the progress
 * of the load.
 *
 * The hook starts the load as a task, so the request returns as soon as the
 * server has received the body. A corpus can therefore load even when the load
 * takes longer than the response timeout of a proxy. The hook then polls the
 * task until the load succeeds, fails, or ends in a cancellation, pausing
 * whenever the page is hidden.
 *
 * Unmounting the component stops the polling alone, because the server finishes
 * the load either way. Follow the load again with {@link useTask}, under the id
 * of the record that `start` returns.
 *
 * @param indexName - This is the name of the index that receives the corpus.
 * @param options - These settings can set the poll interval, the callback for
 * the final record, the headers, and the deadline.
 * @returns The state holds the task, the progress, the result, the failure,
 * and the three functions that control a load.
 * @throws A `NarsilError` with `CONFIG_INVALID` during the render under a
 * provider that holds an engine, because only a server handles imports.
 *
 * @public
 */
export function useImport(indexName: string, options?: NarsilImportOptions): NarsilImportState {
  const client = useServerClient('useImport')
  const [progress, setProgress] = useState<ImportProgress>(NOTHING)

  const polling = useRef<AbortController | null>(null)
  const sending = useRef<AbortController | null>(null)
  const inFlight = useRef(false)
  const reported = useRef<string | null>(null)
  const request = useRef<RequestOptions>(requestOf(options))
  const settled = useEffectEvent((record: TaskRecord) => options?.onSettled?.(record))

  useEffect(() => {
    request.current = requestOf(options)
  })

  useEffect(() => {
    return () => {
      polling.current?.abort()
    }
  }, [])

  const finished = progress.task !== undefined && isTerminalTask(progress.task)
  useEffect(() => {
    const record = progress.task
    if (record === undefined || !finished || reported.current === record.id) return
    reported.current = record.id
    settled(record)
  }, [progress.task, finished])

  const start = useCallback(
    async (source: ImportSource): Promise<TaskRecord> => {
      const controller = new AbortController()
      sending.current = controller
      setProgress({ task: undefined, error: undefined, starting: true })
      try {
        const record = await client.startImport(indexName, source, { ...request.current, signal: controller.signal })
        setProgress({ task: record, error: undefined, starting: false })
        return record
      } catch (err) {
        const failure = asNarsilError(err, 'The import')
        const stopped = controller.signal.aborted
        setProgress({ task: undefined, error: stopped ? undefined : failure, starting: false })
        throw failure
      } finally {
        if (sending.current === controller) sending.current = null
      }
    },
    [client, indexName],
  )

  const taskId = progress.task?.id
  const running = progress.task !== undefined && !finished

  const readTask = (): void => {
    if (taskId === undefined || inFlight.current) return
    const controller = new AbortController()
    polling.current = controller
    inFlight.current = true
    client
      .getTask(taskId, { ...request.current, signal: controller.signal })
      .then(next => {
        setProgress(prev => {
          if (prev.task?.id !== taskId) return prev
          if (next === null) {
            return {
              ...prev,
              error: new NarsilError(
                ServerErrorCodes.TASK_NOT_FOUND,
                `The server no longer holds task "${taskId}", so the outcome of the load is unknown`,
                { taskId },
              ),
            }
          }
          return { task: next, error: undefined, starting: false }
        })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setProgress(prev => (prev.task?.id === taskId ? { ...prev, error: asNarsilError(err, 'The import') } : prev))
      })
      .finally(() => {
        inFlight.current = false
      })
  }

  const cancel = useCallback(() => {
    if (progress.starting) {
      sending.current?.abort()
      return
    }
    if (taskId === undefined || !running) return
    client
      .cancelTask(taskId, request.current)
      .then(next => {
        setProgress(prev => (prev.task?.id === taskId ? { task: next, error: undefined, starting: false } : prev))
      })
      .catch((err: unknown) => {
        if (isNarsilError(err) && err.code === ServerErrorCodes.TASK_NOT_CANCELLABLE) return
        setProgress(prev => (prev.task?.id === taskId ? { ...prev, error: asNarsilError(err, 'The import') } : prev))
      })
  }, [client, taskId, running, progress.starting])

  const reset = useCallback(() => {
    reported.current = null
    setProgress(NOTHING)
  }, [])

  const interval = pollInterval(options?.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS, progress.error !== undefined)
  usePolling(readTask, interval, running)

  return useMemo(
    () => ({
      start,
      cancel,
      reset,
      task: progress.task,
      progress: progress.task?.progress,
      result: progress.task?.result,
      error: progress.error,
      isImporting: progress.starting || running,
    }),
    [start, cancel, reset, progress, running],
  )
}
