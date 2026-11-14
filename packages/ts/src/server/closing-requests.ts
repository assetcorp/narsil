import { ErrorCodes } from '../errors'
import type { ResponseAbort, RouteHandler } from './request'
import { refuseAndClose } from './request-threads/leaving-response'
import type { ResponseSink } from './response'
import type { ServerHandlers } from './routes'
import type { ErrorEnvelope } from './types'

const CLOSING_REFUSAL: ErrorEnvelope = {
  error: {
    code: ErrorCodes.WORKER_CRASHED,
    message: 'The server is closing, so retry the request on a new connection',
  },
}

export interface ClosingRequests {
  track(res: ResponseSink, abort: ResponseAbort): () => void
  refuseOnceClosing(handlers: ServerHandlers): ServerHandlers
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

  function refusing(handler: RouteHandler): RouteHandler {
    return ctx => {
      if (!closing) return handler(ctx)
      refuseAndClose(ctx.res, 503, CLOSING_REFUSAL)
    }
  }

  return {
    track(_res, abort) {
      const request = {}
      running.add(request)
      abort.onAbort(() => settle(request))
      return () => settle(request)
    },
    refuseOnceClosing(handlers) {
      const guarded = { ...handlers }
      for (const route of Object.keys(guarded) as Array<keyof ServerHandlers>) {
        guarded[route] = refusing(handlers[route])
      }
      return guarded
    },
    async close(deadlineMs) {
      closing = true
      if (running.size === 0) return
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        new Promise<void>(resolve => waitingForIdle.push(resolve)),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, deadlineMs)
        }),
      ])
      clearTimeout(timer)
    },
  }
}
