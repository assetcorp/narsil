import { ErrorCodes, NarsilError } from '../../errors'
import { SERVER_CLOSE_ACKNOWLEDGE_GRACE_MS, SERVER_CLOSE_DRAIN_DEADLINE_MS } from '../constants'
import { waitUntilWallClock } from '../wall-clock-wait'
import { closeEveryThreadAtExit, threadCloseAcknowledged, threadCloseAcknowledgedWithin } from './close-at-exit'

export async function closeThreadsByDeadline(
  words: Set<Int32Array<SharedArrayBuffer>>,
  closed: Promise<unknown>,
  deadline: number,
): Promise<void> {
  const drained = waitUntilWallClock(deadline)
  try {
    await Promise.race([closed, drained.reached])
    closeEveryThreadAtExit(words, 0)
    await Promise.all([...words].map(word => threadCloseAcknowledgedWithin(word, SERVER_CLOSE_ACKNOWLEDGE_GRACE_MS)))
    const unacknowledged = [...words].filter(word => !threadCloseAcknowledged(word)).length
    if (unacknowledged > 0) {
      throw new NarsilError(
        ErrorCodes.WORKER_TIMEOUT,
        `Request threads that did not acknowledge closing their connections: ${unacknowledged}; server close deadline: ${SERVER_CLOSE_DRAIN_DEADLINE_MS}ms`,
        { threads: unacknowledged, deadlineMs: SERVER_CLOSE_DRAIN_DEADLINE_MS },
      )
    }
  } finally {
    drained.cancel()
  }
}
