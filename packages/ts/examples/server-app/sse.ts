import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * A guarded server-sent-events response. Every write checks the response is
 * still open, ending is idempotent, and a client disconnect aborts `signal`
 * so the producing work can stop. Without these guards a write after the
 * response ends emits an unhandled 'error' event that kills the dev process.
 */
export interface SseSession {
  /** Aborts when the client disconnects or the response stream errors. */
  readonly signal: AbortSignal
  isOpen(): boolean
  /**
   * Fire-and-forget write for snapshot-style frames (each frame supersedes
   * the previous one). Under backpressure only the newest frame is kept and
   * flushed on drain, so a slow client never buffers an unbounded queue.
   */
  sendLatest(payload: unknown): void
  /**
   * Write for frames that must all be delivered. Resolves once the frame is
   * flushed, or with false when the response closed and delivery stopped.
   */
  send(payload: unknown): Promise<boolean>
  /** Ends the response, flushing a superseded frame still awaiting drain. */
  close(): void
  /** Writes a final frame and ends the response, bypassing coalescing. */
  fail(payload: unknown): void
}

export function openSseSession(req: IncomingMessage, res: ServerResponse): SseSession {
  const controller = new AbortController()
  let ended = false
  let awaitingDrain = false
  let pendingFrame: string | null = null

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const abort = () => controller.abort()
  res.on('error', abort)
  req.on('error', abort)
  res.on('close', () => {
    if (!ended) abort()
    ended = true
  })

  const isOpen = () => !ended && !res.writableEnded && !res.destroyed

  const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`

  const writeFrame = (data: string): void => {
    if (!isOpen()) return
    if (awaitingDrain) {
      pendingFrame = data
      return
    }
    if (!res.write(data)) {
      awaitingDrain = true
      res.once('drain', flushPendingFrame)
    }
  }

  const flushPendingFrame = (): void => {
    awaitingDrain = false
    const buffered = pendingFrame
    pendingFrame = null
    if (buffered !== null) writeFrame(buffered)
  }

  const sendLatest = (payload: unknown): void => {
    writeFrame(frame(payload))
  }

  const send = (payload: unknown): Promise<boolean> => {
    if (!isOpen()) return Promise.resolve(false)
    if (res.write(frame(payload))) return Promise.resolve(true)
    return new Promise(resolve => {
      const settle = (delivered: boolean) => {
        res.off('drain', onDrain)
        res.off('close', onClose)
        resolve(delivered)
      }
      const onDrain = () => settle(isOpen())
      const onClose = () => settle(false)
      res.once('drain', onDrain)
      res.once('close', onClose)
    })
  }

  const close = (): void => {
    if (!isOpen()) {
      ended = true
      return
    }
    ended = true
    if (pendingFrame !== null) {
      const buffered = pendingFrame
      pendingFrame = null
      res.end(buffered)
      return
    }
    res.end()
  }

  const fail = (payload: unknown): void => {
    if (!isOpen()) {
      ended = true
      return
    }
    ended = true
    pendingFrame = null
    res.end(frame(payload))
  }

  return { signal: controller.signal, isOpen, sendLatest, send, close, fail }
}
