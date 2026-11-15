import { ErrorCodes } from '../errors'
import type { ResponseAbort } from './request'
import { LeavingResponse, refuseAndClose } from './request-threads/leaving-response'
import type { ResponseSink } from './response'
import type { ErrorEnvelope } from './types'
import { waitUntilWallClock } from './wall-clock-wait'

const CLOSING_REFUSAL: ErrorEnvelope = {
  error: {
    code: ErrorCodes.WORKER_CRASHED,
    message: 'The server is closing, so retry the request on a new connection',
  },
}

export interface ClosingRequests {
  accept(res: ResponseSink): boolean
  respondThrough(res: ResponseSink): ResponseSink
  track(res: ResponseSink, abort: ResponseAbort): () => void
  close(deadlineMs: number): Promise<void>
}

export function watchClosingRequests(): ClosingRequests {
  let closing = false
  const running = new Set<object>()
  const waitingForIdle: Array<() => void> = []

  function settle(request: object): void {
    if (!running.delete(request) || running.size > 0) return
    for (const resume of waitingForIdle.splice(0)) resume()
  }

  return {
    accept(res) {
      if (!closing) return true
      refuseAndClose(res, 503, CLOSING_REFUSAL)
      return false
    },
    respondThrough(res) {
      return new LeavingResponse(res, () => closing)
    },
    track(res, abort) {
      const request = {}
      running.add(request)
      let handled = false
      const finish = (): void => {
        if (abort.aborted || (handled && (!(res instanceof LeavingResponse) || res.isFinished))) settle(request)
      }
      if (res instanceof LeavingResponse) res.whenFinished(finish)
      abort.onAbort(finish)
      return () => {
        handled = true
        finish()
      }
    },
    async close(deadlineMs) {
      closing = true
      if (running.size === 0) return
      const deadline = waitUntilWallClock(Date.now() + deadlineMs)
      try {
        await Promise.race([new Promise<void>(resolve => waitingForIdle.push(resolve)), deadline.reached])
      } finally {
        deadline.cancel()
      }
    },
  }
}
