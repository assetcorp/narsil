import type { TaskListPage, TaskListQuery, TaskRecord } from '../server/types'
import { DEFAULT_TASK_POLL_INTERVAL_MS } from './constants'
import type { NarsilReadOptions, NarsilReadState } from './options'
import { usePolling } from './poll'
import { useRead } from './read'
import { isTerminalTask, pollInterval } from './task-state'

/**
 * These settings say how a task hook follows the work.
 *
 * @public
 */
export interface NarsilTaskOptions extends NarsilReadOptions {
  /** The hook asks again this often while the task runs, and every 250 ms
   * unless you say otherwise, which is how often a running import writes its
   * progress. It stops once the task reaches a final status. */
  pollIntervalMs?: number
}

/**
 * Follows one long-running operation, and stops asking once it finishes.
 *
 * The hook polls while the task is queued or running, pauses while the page is
 * hidden, and reads the figures once more as soon as the page comes back. A
 * failed task arrives as a record carrying its `error`, because a part-finished
 * import still reports what it indexed, so read the status you get.
 *
 * @param taskId - This names the task to follow, and a nullish or empty id
 * switches the hook off.
 * @param options - These set the poll interval, switch the hook off, and carry
 * the headers and the deadline.
 * @returns The state holds the record, and `data: null` says the server no
 * longer holds it.
 *
 * @public
 */
export function useTask(
  taskId: string | null | undefined,
  options?: NarsilTaskOptions,
): NarsilReadState<TaskRecord | null> {
  const id = taskId ?? ''
  const enabled = (options?.enabled ?? true) && id.length > 0
  const state = useRead(['getTask', id], (client, request) => client.getTask(id, request), {
    ...options,
    enabled,
    refreshIntervalMs: 0,
  })

  const running = state.data !== null && !isTerminalTask(state.data)
  const interval = pollInterval(options?.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS, state.error !== undefined)
  usePolling(state.refresh, interval, enabled && running)

  return state
}

/**
 * Lists the task records the server still holds, newest first.
 *
 * Set `refreshIntervalMs` to keep a table of running work up to date.
 *
 * @param query - This says which records to keep and where the page starts.
 * Omit it for the newest 20 records.
 * @param options - These switch the hook off, keep the last page on screen, and
 * set the refresh interval, the headers, and the deadline.
 * @returns The state holds the records, the total the filters matched, and the
 * offset the next page starts at.
 *
 * @public
 */
export function useTasks(query?: TaskListQuery, options?: NarsilReadOptions): NarsilReadState<TaskListPage> {
  return useRead(['listTasks', query], (client, request) => client.listTasks(query, request), options)
}
