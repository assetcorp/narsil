import type { TaskListPage, TaskListQuery, TaskRecord } from '../server/types'
import { DEFAULT_TASK_POLL_INTERVAL_MS } from './constants'
import { useServerClient } from './context'
import type { NarsilReadOptions, NarsilReadState } from './options'
import { usePolling } from './poll'
import { useRead } from './read'
import { NO_INDEX } from './store'
import { isTerminalTask, pollInterval } from './task-state'

/**
 * These settings control how often a task hook polls its task.
 *
 * @public
 */
export interface NarsilTaskOptions extends Omit<NarsilReadOptions, 'refreshIntervalMs'> {
  /** The hook polls the task at this interval in milliseconds while the task
   * is in progress, which is 250 unless you set another value. That default
   * matches the interval at which the server updates the figures of an import.
   * The hook stops polling once the task reaches a final status. */
  pollIntervalMs?: number
}

/**
 * This hook polls one long-running task on a server until the task reaches a
 * final status.
 *
 * The hook pauses polling while the page is hidden, then fetches the figures
 * once more as soon as the page is visible again. A failed task comes back as
 * a record with its `error` field set, because the record of a part-finished
 * import still counts the documents that it indexed. Check the `status` field
 * to tell the outcomes apart.
 *
 * @param taskId - This is the id of the task to poll, where a nullish or empty
 * id switches the hook off.
 * @param options - These settings can set the poll interval, switch the hook
 * off, and set the headers and the deadline.
 * @returns The state holds the record, while `data: null` means that the
 * server no longer holds the task.
 * @throws A `NarsilError` with `CONFIG_INVALID` during the render under a
 * provider that holds an engine, because only a server handles tasks.
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
    client,
    ['getTask', id],
    (server, request) => server.getTask(id, request),
    { ...options, enabled, refreshIntervalMs: 0 },
    NO_INDEX,
  )

  const running = state.data !== null && !isTerminalTask(state.data)
  const interval = pollInterval(options?.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS, state.error !== undefined)
  usePolling(state.refresh, interval, enabled && running)

  return state
}

/**
 * This hook lists the task records that the server holds, with the newest
 * record first.
 *
 * Set `refreshIntervalMs` to keep a table of the work in progress up to date.
 *
 * @param query - This selects the records and sets where the page starts.
 * Without it, the hook lists the newest 20 records.
 * @param options - These settings can switch the hook off, keep the last page
 * on screen, and set the refresh interval, the headers, and the deadline.
 * @returns The state holds the records, the total that the filters matched,
 * and the offset where the next page starts.
 * @throws A `NarsilError` with `CONFIG_INVALID` during the render under a
 * provider that holds an engine, because only a server handles tasks.
 *
 * @public
 */
export function useTasks(query?: TaskListQuery, options?: NarsilReadOptions): NarsilReadState<TaskListPage> {
  const client = useServerClient('useTasks')
  return useRead(client, ['listTasks', query], (server, request) => server.listTasks(query, request), options, NO_INDEX)
}
