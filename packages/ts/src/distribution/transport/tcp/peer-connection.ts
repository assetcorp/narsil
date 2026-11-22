import type { Socket } from 'node:net'
import { TransportError, TransportErrorCodes, type TransportMessage } from '../types'
import { decodeTransportMessage, FrameParser, type WireFrame } from './framing'
import { answerPendingStream, createPendingStream, deliverStreamChunk, type PendingStream } from './pending-stream'
import { FRAME_TYPE_RESPONSE, FRAME_TYPE_STREAM_CHUNK, FRAME_TYPE_STREAM_END } from './types'

interface PendingRequest {
  resolve: (message: TransportMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class PeerConnection {
  private readonly requests = new Map<string, PendingRequest>()
  private readonly streams = new Map<string, PendingStream>()
  private lost = false

  constructor(
    private readonly target: string,
    private readonly socket: Socket,
  ) {
    const parser = new FrameParser(frame => {
      this.dispatch(frame)
    })
    socket.on('data', (data: Buffer) => {
      try {
        parser.feed(new Uint8Array(data))
      } catch (error) {
        this.lose(error instanceof Error ? error.message : String(error))
      }
    })
    socket.on('error', error => {
      this.lose(error.message)
    })
    socket.on('close', () => {
      this.close(this.unavailable(`Connection to '${target}' closed before a response was received`))
    })
  }

  send(requestId: string, frame: Uint8Array, timeoutMs: number): Promise<TransportMessage> {
    this.assertCanSend(requestId)
    return new Promise<TransportMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId)
        reject(
          new TransportError(
            TransportErrorCodes.TIMEOUT,
            `Request to '${this.target}' timed out after ${timeoutMs}ms`,
            { target: this.target, requestId, timeoutMs },
          ),
        )
      }, timeoutMs)
      const pending: PendingRequest = { resolve, reject, timer }
      this.requests.set(requestId, pending)

      this.socket.write(frame, error => {
        if (!error || this.requests.get(requestId) !== pending) return
        clearTimeout(timer)
        this.requests.delete(requestId)
        reject(this.unavailable(`Failed to write to '${this.target}': ${error.message}`, { requestId }))
      })
    })
  }

  stream(requestId: string, frame: Uint8Array, timeoutMs: number, handler: (chunk: Uint8Array) => void): Promise<void> {
    this.assertCanSend(requestId)
    return new Promise<void>((resolve, reject) => {
      const pending = createPendingStream({
        target: this.target,
        requestId,
        timeoutMs,
        handler,
        resolve,
        reject,
        forget: () => {
          if (this.streams.get(requestId) === pending) this.streams.delete(requestId)
        },
      })
      this.streams.set(requestId, pending)

      this.socket.write(frame, error => {
        if (!error || this.streams.get(requestId) !== pending) return
        pending.fail(this.unavailable(`Failed to write stream to '${this.target}': ${error.message}`, { requestId }))
      })
    })
  }

  close(error: TransportError): void {
    if (this.lost) return
    this.lost = true
    this.socket.destroy()

    const requests = [...this.requests.values()]
    const streams = [...this.streams.values()]
    this.requests.clear()
    this.streams.clear()
    for (const pending of requests) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    for (const pending of streams) pending.fail(error)
  }

  private lose(reason: string): void {
    this.close(this.unavailable(`Connection to '${this.target}' lost: ${reason}`))
  }

  private unavailable(message: string, details: Record<string, unknown> = {}): TransportError {
    return new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, message, { target: this.target, ...details })
  }

  private assertCanSend(requestId: string): void {
    let reason: string | undefined
    if (this.lost || this.socket.destroyed || this.socket.writableEnded) {
      reason = `The connection to '${this.target}' closed before the request left`
    } else if (this.requests.has(requestId) || this.streams.has(requestId)) {
      reason = `A request with the id '${requestId}' already waits for '${this.target}', so this one was not sent`
    }
    if (reason !== undefined) {
      throw new TransportError(TransportErrorCodes.CONNECT_FAILED, reason, { target: this.target, requestId })
    }
  }

  private dispatch({ frameType, requestId, data }: WireFrame): void {
    if (frameType === FRAME_TYPE_RESPONSE) {
      const request = this.requests.get(requestId)
      if (request !== undefined) {
        this.requests.delete(requestId)
        clearTimeout(request.timer)
        this.answerRequest(request, data)
        return
      }
      const stream = this.streams.get(requestId)
      if (stream !== undefined) answerPendingStream(stream, requestId, data)
      return
    }

    const stream = this.streams.get(requestId)
    if (stream === undefined) return
    if (frameType === FRAME_TYPE_STREAM_CHUNK) {
      deliverStreamChunk(stream, data)
    } else if (frameType === FRAME_TYPE_STREAM_END) {
      this.streams.delete(requestId)
      clearTimeout(stream.timer)
      stream.resolve()
    }
  }

  private answerRequest(request: PendingRequest, data: Uint8Array): void {
    try {
      request.resolve(decodeTransportMessage(data))
    } catch (error) {
      request.reject(
        new TransportError(
          TransportErrorCodes.DECODE_FAILED,
          `Failed to decode response: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    }
  }
}
