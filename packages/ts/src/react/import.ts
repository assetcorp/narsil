import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { ImportSource, RequestOptions } from '../client'
import { NarsilError, ServerErrorCodes } from '../errors'
import type { ImportResult, TaskProgress, TaskRecord } from '../server/types'
import { DEFAULT_TASK_POLL_INTERVAL_MS } from './constants'
import { useNarsilClient } from './context'
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
  /** The hook asks the server how far the load has gone this often, and every
   * 250 ms unless you say otherwise, which is how often the server writes the
   * figures. It leaves five seconds between attempts while the server is
   * failing. */
  pollIntervalMs?: number
  /** The hook calls this once the load reaches a final status, whichever status
   * that is. */
  onSettled?: (record: TaskRecord) => void
}

/**
 * What {@link useImport} reports, and what it offers to call.
 *
 * @public
 */
export interface NarsilImportState {
  /**
   * Sends a corpus and returns once the server has read the body and taken the
   * work on. The server loads the documents afterwards, and this hook follows
   * that work.
   *
   * @param source - These are the documents, or the NDJSON you already hold.
   * @returns The record is the task the server started.
   * @throws A `NarsilError` under the code the server sent, and with
   * `NOT_FOUND` where the server predates the asynchronous import.
   */
  start: (source: ImportSource) => Promise<TaskRecord>
  /** Asks the running load to stop. Calling it while the corpus is still going
   * up stops the upload, and calling it afterwards asks the server to stop the
   * task, which stops between batches, so whatever it had already written stays
   * written. */
  cancel: () => void
  /** Clears the record and the failure, ready for another load. */
  reset: () => void
  /** This is the task, from the moment the server takes the load on. */
  task: TaskRecord | undefined
  /** This is how far the load has gone, which a progress bar reads. */
  progress: TaskProgress | undefined
  /** This counts what the server accepted and refused, and it arrives once the
   * load finishes. */
  result: ImportResult | undefined
  /** This is the failure that stopped the load, or the one the last poll ended
   * on. */
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
 * server has read the body. A corpus that would outlast a proxy's response
 * timeout therefore still loads. The hook then polls the task, pausing while
 * the page is hidden, until the load succeeds, fails, or is cancelled.
 *
 * Unmounting the component stops the polling alone, because the server finishes
 * the load either way. Follow it again with {@link useTask}, under the id of the
 * record `start` returned.
 *
 * @param indexName - This names the index that receives the corpus.
 * @param options - These set the poll interval, the callback for the final
 * record, the headers, and the deadline.
 * @returns The state holds the task, the progress, the result, the failure, and
 * the three methods that drive a load.
 *
 * @public
 */
export function useImport(indexName: string, options?: NarsilImportOptions): NarsilImportState {
  const client = useNarsilClient()
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
        if (err instanceof NarsilError && err.code === ServerErrorCodes.TASK_NOT_CANCELLABLE) return
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
