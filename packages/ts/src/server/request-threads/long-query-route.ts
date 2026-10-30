import type { MessagePort } from 'node:worker_threads'
import { MAX_LONG_QUERIES_IN_FLIGHT, REQUEST_THREAD_MOVE_AFTER_MS } from '../constants'
import { ServerErrorCodes } from '../errors'
import type { RouteContext } from '../request'
import { sendError } from '../response'
import { isLongQueryPortNote, type RelayedRoute } from './messages'
import { createRelayClient, type RelayClient } from './relay-client'

export interface LongQueryRoute {
  moveAfterMs(): number | undefined
  move(route: RelayedRoute, ctx: RouteContext): Promise<boolean>
  close(): void
}

export function routeLongQueries(
  mainPort: MessagePort,
  inFlight: SharedArrayBuffer,
  touchIntervalMs: number,
): LongQueryRoute {
  const counter = new Int32Array(inFlight)
  let relay: RelayClient | null = null

  mainPort.on('message', (message: unknown) => {
    if (!isLongQueryPortNote(message)) return
    relay?.close()
    const opened = createRelayClient(message.port, touchIntervalMs)
    relay = opened
    message.port.on('close', () => {
      if (relay === opened) relay = null
    })
  })

  return {
    moveAfterMs: () => (relay === null ? undefined : REQUEST_THREAD_MOVE_AFTER_MS),
    async move(route, ctx) {
      const target = relay
      if (target === null) return false
      if (Atomics.add(counter, 0, 1) >= MAX_LONG_QUERIES_IN_FLIGHT) {
        Atomics.sub(counter, 0, 1)
        sendError(
          ctx.res,
          429,
          ServerErrorCodes.TOO_MANY_REQUESTS,
          `The server is already answering ${MAX_LONG_QUERIES_IN_FLIGHT} searches whose pattern work is long, so it refuses another. Retry once those searches answer.`,
          { limit: MAX_LONG_QUERIES_IN_FLIGHT },
        )
        return true
      }
      let counted = true
      const release = (): void => {
        if (!counted) return
        counted = false
        Atomics.sub(counter, 0, 1)
      }
      ctx.abort.onAbort(release)
      let lost = false
      try {
        if (!ctx.abort.aborted) {
          await target.request(route, ctx, () => {
            lost = true
          })
        }
      } finally {
        release()
      }
      return !lost
    },
    close() {
      relay?.close()
      relay = null
    },
  }
}
