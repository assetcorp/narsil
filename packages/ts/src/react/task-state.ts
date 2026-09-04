import type { TaskRecord } from '../server/types'
import { ERROR_RETRY_INTERVAL_MS } from './constants'

/**
 * Says how long a hook waits before it asks about a task again.
 *
 * @param interval - This is the interval the caller asked for.
 * @param failed - Pass true where the last attempt ended in a failure.
 * @returns The wait is the caller's interval, or five seconds while the server
 * is failing, whichever is longer.
 */
export function pollInterval(interval: number, failed: boolean): number {
  return failed ? Math.max(interval, ERROR_RETRY_INTERVAL_MS) : interval
}

/**
 * Reports whether a task has finished, whichever way it finished.
 *
 * @param record - This is the record to read, and a missing one counts as
 * unfinished, because the answer has yet to arrive.
 * @returns This is true for a task that succeeded, failed, or was cancelled.
 */
export function isTerminalTask(record: TaskRecord | null | undefined): boolean {
  if (record === null || record === undefined) return false
  return record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled'
}
