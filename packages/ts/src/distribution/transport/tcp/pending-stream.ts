import { TransportError, TransportErrorCodes } from '../types'

export interface PendingStream {
  target: string
  handler: (chunk: Uint8Array) => void
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  rearm(): void
}

export interface PendingStreamInput {
  target: string
  requestId: string
  timeoutMs: number
  handler: (chunk: Uint8Array) => void
  resolve: () => void
  reject: (error: Error) => void
  forget(): void
}

export function createPendingStream(input: PendingStreamInput): PendingStream {
  const { target, requestId, timeoutMs, reject } = input
  const expire = (): void => {
    input.forget()
    reject(
      new TransportError(
        TransportErrorCodes.TIMEOUT,
        `No chunk of the stream from '${target}' arrived within ${timeoutMs}ms`,
        { target, requestId, timeoutMs },
      ),
    )
  }
  const pending: PendingStream = {
    target,
    handler: input.handler,
    resolve: input.resolve,
    reject,
    timer: setTimeout(expire, timeoutMs),
    rearm: () => {
      clearTimeout(pending.timer)
      pending.timer = setTimeout(expire, timeoutMs)
    },
  }
  return pending
}
