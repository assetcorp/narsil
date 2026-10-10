import type { TaskListPage, TaskListQuery, TaskRecord } from '../server/types'
import { DEFAULT_TASK_POLL_INTERVAL_MS } from './constants'
import { useServerClient } from './context'
import type { NarsilReadOptions, NarsilReadState } from './options'
import { usePolling } from './poll'
import { useRead } from './read'
import { NO_INDEX } from './store'
import { isTerminalTask, pollInterval } from './task-state'

/**
 * These settings say how a task hook follows the work.
 *
 * @public
 */
export interface NarsilTaskOptions extends Omit<NarsilReadOptions, 'refreshIntervalMs'> {
  /** The hook polls the task at this interval while the task is in progress,
   * every 250 ms unless you set another value, which matches how often an
   * import in progress updates its figures. The hook stops once the task
   * reaches a final status. */
  pollIntervalMs?: number
}

/**
 * Polls one long-running operation on a server until the operation finishes.
 *
 * The hook pauses polling while the page is hidden, then fetches the figures
 * once more as soon as the page is visible again. A failed task comes back as
 * a record with its `error` field set, because a part-finished import still
 * reports what it indexed, so check the status.
 *
 * @param taskId - This names the task to follow, and a nullish or empty id
 * switches the hook off.
 * @param options - These set the poll interval, switch the hook off, and set
 * the headers and the deadline.
 * @returns The state holds the record, and `data: null` means that the server
 * no longer holds it.
 * @throws A `NarsilError` with `CONFIG_INVALID` as it renders under a provider
 * that holds an engine, because only a server handles tasks.
 *
 * @public
 */
export function useTask(
  taskId: string | null | undefined,
  options?: NarsilTaskOptions,
): NarsilReadState<TaskRecord | null> {
  const client = useServerClient('useTask')
  const id = taskId ?? ''
  const enabled = (options?.enabled ?? true) && id.length > 0
  const state = useRead(
    ['getTask', id],
    (_reader, request) => client.getTask(id, request),
    { ...options, enabled, refreshIntervalMs: 0 },
    NO_INDEX,
  )

  const running = state.data !== null && !isTerminalTask(state.data)
  const interval = pollInterval(options?.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS, state.error !== undefined)
  usePolling(state.refresh, interval, enabled && running)

  return state
}

/**
 * Lists the task records that the server still holds, newest first.
 *
 * Set `refreshIntervalMs` to keep a table of the work in progress up to date.
 *
 * @param query - This sets which records to keep and where the page starts.
 * Omit it for the newest 20 records.
 * @param options - These switch the hook off, keep the last page on screen, and
 * set the refresh interval, the headers, and the deadline.
 * @returns The state holds the records, the total that the filters matched, and
 * the offset where the next page starts.
 * @throws A `NarsilError` with `CONFIG_INVALID` as it renders under a provider
 * that holds an engine, because only a server handles tasks.
 *
 * @public
 */
export function useTasks(query?: TaskListQuery, options?: NarsilReadOptions): NarsilReadState<TaskListPage> {
  const client = useServerClient('useTasks')
  return useRead(['listTasks', query], (_reader, request) => client.listTasks(query, request), options, NO_INDEX)
}
