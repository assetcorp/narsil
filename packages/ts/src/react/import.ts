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
 * These settings say how {@link useImport} runs a load and follows it.
 *
 * @public
 */
export interface NarsilImportOptions extends NarsilRequestSettings {
  /** The hook asks the server how far the load has gone at this interval,
   * every 250 ms unless you set another value, which matches how often the
   * server updates the figures. The hook waits five seconds between attempts
   * while the server is failing. */
  pollIntervalMs?: number
  /** The hook calls this once the load reaches a final status, whichever status
   * that is. */
  onSettled?: (record: TaskRecord) => void
}

/**
 * What {@link useImport} reports, and the methods that it returns.
 *
 * @public
 */
export interface NarsilImportState {
  /**
   * Sends a corpus, and returns once the server has received the body and
   * started the task. The server loads the documents afterwards, while the hook
   * polls the task.
   *
   * @param source - These are the documents, or the NDJSON that you already
   * hold.
   * @returns The record is the task the server started.
   * @throws A `NarsilError` under the code the server sent, and with
   * `NOT_FOUND` where the server predates the asynchronous import.
   */
  start: (source: ImportSource) => Promise<TaskRecord>
  /** Asks the load in progress to stop. While the browser is still sending the
   * corpus, a call aborts the upload, and afterwards it asks the server to stop
   * the task. The server stops between batches, so the documents that it has
   * already written stay in the index. */
  cancel: () => void
  /** Clears the record and the failure, ready for another load. */
  reset: () => void
  /** This is the task, from the moment the server starts it. */
  task: TaskRecord | undefined
  /** This is how far the load has gone, which suits a progress bar. */
  progress: TaskProgress | undefined
  /** This counts the documents that the server indexed and refused, and the
   * hook sets it once the load finishes. */
  result: ImportResult | undefined
  /** This is the failure that stopped the load, or the one that the last poll
   * ended on. */
  error: NarsilError | undefined
  /** This is true from the moment you call `start` until the load reaches a
   * final status. */
  isImporting: boolean
}

interface ImportProgress {
  task: TaskRecord | undefined
  error: NarsilError | undefined
  starting: boolean
}

const NOTHING: ImportProgress = { task: undefined, error: undefined, starting: false }

/**
 * Loads a corpus into an index and reports how far the load has gone.
 *
 * The hook starts the load as a task, so the request returns as soon as the
 * server has received the body. A corpus that takes longer to load than the
 * response timeout of a proxy therefore still loads. The hook then polls the
 * task until the load succeeds, fails, or ends in a cancellation. While the
 * page is hidden, the hook pauses polling.
 *
 * Unmounting the component stops the polling alone, because the server finishes
 * the load either way. Follow the load again with {@link useTask}, under the id
 * of the record that `start` returns.
 *
 * @param indexName - This names the index that receives the corpus.
 * @param options - These set the poll interval, the callback for the final
 * record, the headers, and the deadline.
 * @returns The state holds the task, the progress, the result, the failure, and
 * the three methods that drive a load.
 * @throws A `NarsilError` with `CONFIG_INVALID` as it renders under a provider
 * that holds an engine, because only a server handles imports.
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
