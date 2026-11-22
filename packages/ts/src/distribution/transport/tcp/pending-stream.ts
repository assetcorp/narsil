import { carrierFailureOf } from '../carrier-error'
import { TransportError, TransportErrorCodes } from '../types'
import { decodeTransportMessage } from './framing'

export interface PendingStream {
  target: string
  handler: (chunk: Uint8Array) => void
  resolve: () => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
  rearm(): void
  fail(error: unknown): void
}

export interface PendingStreamInput {
  target: string
  requestId: string
  timeoutMs: number
  handler: (chunk: Uint8Array) => void
  resolve: () => void
  reject: (error: unknown) => void
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
    fail: error => {
      clearTimeout(pending.timer)
      input.forget()
      reject(error)
    },
  }
  return pending
}

export function deliverStreamChunk(pending: PendingStream, chunk: Uint8Array): void {
  pending.rearm()
  try {
    pending.handler(chunk)
  } catch (err) {
    pending.fail(err)
  }
}

export function answerPendingStream(pending: PendingStream, requestId: string, data: Uint8Array): void {
  const target = pending.target
  let message: ReturnType<typeof decodeTransportMessage>
  try {
    message = decodeTransportMessage(data)
  } catch (err) {
    pending.fail(
      new TransportError(
        TransportErrorCodes.DECODE_FAILED,
        `Failed to decode stream frame: ${err instanceof Error ? err.message : String(err)}`,
        { target, requestId },
      ),
    )
    return
  }
  const carrierFailure = carrierFailureOf(message, target)
  if (carrierFailure !== null) {
    pending.fail(carrierFailure)
    return
  }
  deliverStreamChunk(pending, message.payload)
}
