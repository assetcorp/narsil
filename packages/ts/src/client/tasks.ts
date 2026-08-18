import { ClientErrorCodes, NarsilError, ServerErrorCodes } from '../errors'
import type { TaskListPage, TaskListQuery, TaskRecord } from '../server/types'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { taskPath } from './paths'
import { readBody } from './response-shape'

const DEFAULT_POLL_INTERVAL_MS = 250

/**
 * These settings say how {@link TaskOperations.waitForTask} follows a task.
 *
 * `timeoutMs` bounds each poll request, as it does everywhere else, while
 * `waitTimeoutMs` bounds the whole wait.
 *
 * @public
 */
export interface WaitForTaskOptions extends RequestOptions {
  /**
   * The client asks the server again this often, and every 250 ms unless you
   * say otherwise, which is how often a running import writes its progress.
   */
  pollIntervalMs?: number
  /**
   * The wait fails with `CLIENT_TASK_TIMEOUT` after this many milliseconds
   * while the task keeps running. It waits for as long as the task takes unless
   * you set this.
   */
  waitTimeoutMs?: number
  /**
   * The client calls this each time the record changes, which is what a
   * progress bar renders. It calls it for the terminal record as well, and
   * never twice for the same figures.
   */
  onProgress?: (record: TaskRecord) => void
}

/**
 * These methods follow the long-running operations: an import, a restore, a
 * rebalance, a vector optimisation, and an analysis rebuild.
 *
 * Each of those answers straight away with a task record, so these methods
 * read, follow, and stop the work behind it.
 *
 * @public
 */
export interface TaskOperations {
  /**
   * Reads one task record back.
   *
   * @param taskId - This names the task to read.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The record comes back, and `null` says the server holds no such
   * task, which is also the answer once a record has gone.
   */
  getTask(taskId: string, options?: RequestOptions): Promise<TaskRecord | null>
  /**
   * Lists task records, newest first.
   *
   * @param query - This says which records to keep and where the page starts.
   * Omit it for the newest 20 records the server still holds.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The page holds the records, the total the filters matched, and the
   * offset the next page starts at.
   */
  listTasks(query?: TaskListQuery, options?: RequestOptions): Promise<TaskListPage>
  /**
   * Asks a running task to stop.
   *
   * The work stops between units, so the task reaches `cancelled` only once it
   * has stopped, and a request that comes too late leaves it `succeeded`.
   * Whatever the task had already written stays written.
   *
   * @param taskId - This names the task to stop.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The record shows the task as it stood when the cancel arrived.
   * @throws A `NarsilError` with `TASK_NOT_FOUND` for an unknown task,
   * `TASK_NOT_CANCELLABLE` for one that has already finished, and
   * `TASK_OWNED_BY_ANOTHER_INSTANCE` when another server instance runs it.
   */
  cancelTask(taskId: string, options?: RequestOptions): Promise<TaskRecord>
  /**
   * Polls a task until it finishes, reporting each step on the way.
   *
   * A failed task comes back with `status: 'failed'` and its `error` set while
   * this method throws nothing, because a part-finished import still reports
   * what it indexed. Read the status you get back.
   *
   * @param taskId - This names the task to follow.
   * @param options - These set the poll interval, the overall deadline, the
   * progress callback, and the signal, per-request deadline, and headers.
   * @returns The record shows the task at whichever terminal status it reached.
   * @throws A `NarsilError` with `CLIENT_TASK_TIMEOUT` when the wait passes
   * `waitTimeoutMs`, and with `TASK_NOT_FOUND` when the record expires before
   * the task finishes.
   */
  waitForTask(taskId: string, options?: WaitForTaskOptions): Promise<TaskRecord>
}

function isTerminal(record: TaskRecord): boolean {
  return record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled'
}

function progressKey(record: TaskRecord): string {
  const progress = record.progress
  if (progress === undefined) return record.status
  return `${record.status}:${progress.bytesProcessed}:${progress.indexed}:${progress.failed}`
}

function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, milliseconds)
    function stop(): void {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', stop, { once: true })
  })
}

function listQuery(query: TaskListQuery | undefined): Record<string, string | undefined> {
  return {
    indexName: query?.indexName,
    type: query?.type === undefined || query.type.length === 0 ? undefined : query.type.join(','),
    status: query?.status === undefined || query.status.length === 0 ? undefined : query.status.join(','),
    from: query?.from === undefined ? undefined : String(query.from),
    limit: query?.limit === undefined ? undefined : String(query.limit),
  }
}

export function createTaskOperations(transport: Transport): TaskOperations {
  const operations: TaskOperations = {
    async getTask(taskId, options) {
      const path = taskPath(taskId)
      const payload = await transport.jsonOrNull({ method: 'GET', path, options }, ServerErrorCodes.TASK_NOT_FOUND)
      return payload === null ? null : readBody<TaskRecord>(payload, path)
    },
    async listTasks(query, options) {
      const path = '/tasks'
      const payload = await transport.json({ method: 'GET', path, query: listQuery(query), options })
      return readBody<TaskListPage>(payload, path)
    },
    async cancelTask(taskId, options) {
      const path = `${taskPath(taskId)}/_cancel`
      return readBody<TaskRecord>(await transport.json({ method: 'POST', path, options }), path)
    },
    async waitForTask(taskId, options) {
      const interval = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
      const waitTimeoutMs = options?.waitTimeoutMs ?? 0
      const startedAt = Date.now()
      let reported: string | null = null

      for (;;) {
        if (options?.signal?.aborted === true) {
          throw new NarsilError(
            ClientErrorCodes.CLIENT_REQUEST_ABORTED,
            `The caller stopped waiting for task "${taskId}"`,
            { taskId },
          )
        }

        const record = await operations.getTask(taskId, options)
        if (record === null) {
          throw new NarsilError(
            ServerErrorCodes.TASK_NOT_FOUND,
            `The server no longer holds task "${taskId}", so its outcome is unknown`,
            { taskId },
          )
        }

        const key = progressKey(record)
        if (key !== reported) {
          reported = key
          options?.onProgress?.(record)
        }
        if (isTerminal(record)) return record

        if (waitTimeoutMs > 0 && Date.now() - startedAt >= waitTimeoutMs) {
          throw new NarsilError(
            ClientErrorCodes.CLIENT_TASK_TIMEOUT,
            `Task "${taskId}" was still ${record.status} after ${waitTimeoutMs} ms, and it keeps running`,
            { taskId, waitTimeoutMs, status: record.status },
          )
        }
        await sleep(interval, options?.signal)
      }
    },
  }

  return operations
}
