import { decode, encode } from '@msgpack/msgpack'
import { MAX_MESSAGE_SIZE_BYTES, TransportError, TransportErrorCodes, type TransportMessage } from '../types'
import { LENGTH_PREFIX_BYTES } from './types'

export interface WireFrame {
  frameType: number
  requestId: string
  data: Uint8Array
}

export function encodeFrame(frameType: number, requestId: string, data: Uint8Array): Uint8Array {
  const envelope = encode({ frameType, requestId, data })
  const totalLength = envelope.byteLength
  if (totalLength > MAX_MESSAGE_SIZE_BYTES) {
    throw new TransportError(
      TransportErrorCodes.MESSAGE_TOO_LARGE,
      `Encoded frame (${totalLength} bytes) exceeds the ${MAX_MESSAGE_SIZE_BYTES} byte limit`,
      { payloadSize: totalLength },
    )
  }
  const buffer = new Uint8Array(LENGTH_PREFIX_BYTES + totalLength)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  view.setUint32(0, totalLength, false)
  buffer.set(envelope, LENGTH_PREFIX_BYTES)
  return buffer
}

export function encodeTransportMessage(message: TransportMessage): Uint8Array {
  return new Uint8Array(
    encode({
      type: message.type,
      sourceId: message.sourceId,
      requestId: message.requestId,
      payload: message.payload,
    }),
  )
}

export function decodeTransportMessage(data: Uint8Array): TransportMessage {
  const decoded = decode(data) as Record<string, unknown>
  return {
    type: decoded.type as string,
    sourceId: decoded.sourceId as string,
    requestId: decoded.requestId as string,
    payload: new Uint8Array(decoded.payload as ArrayLike<number>),
  }
}

const BUFFER_LIMIT = MAX_MESSAGE_SIZE_BYTES + LENGTH_PREFIX_BYTES

export class FrameParser {
  private chunks: Uint8Array[] = []
  private totalLength = 0
  private onFrame: (frame: WireFrame) => void

  constructor(onFrame: (frame: WireFrame) => void) {
    this.onFrame = onFrame
  }

  feed(data: Uint8Array): void {
    this.totalLength += data.byteLength
    if (this.totalLength > BUFFER_LIMIT) {
      const exceeded = this.totalLength
      this.chunks = []
      this.totalLength = 0
      throw new TransportError(
        TransportErrorCodes.MESSAGE_TOO_LARGE,
        `Accumulated buffer (${exceeded} bytes) exceeds the allowed limit`,
        { accumulatedBytes: exceeded },
      )
    }
    this.chunks.push(data)

    let buffer = this.compact()

    while (buffer.byteLength >= LENGTH_PREFIX_BYTES) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      const frameLength = view.getUint32(0, false)

      if (frameLength > MAX_MESSAGE_SIZE_BYTES) {
        this.chunks = []
        this.totalLength = 0
        throw new TransportError(
          TransportErrorCodes.MESSAGE_TOO_LARGE,
          `Incoming frame (${frameLength} bytes) exceeds the ${MAX_MESSAGE_SIZE_BYTES} byte limit`,
          { payloadSize: frameLength },
        )
      }

      const totalNeeded = LENGTH_PREFIX_BYTES + frameLength
      if (buffer.byteLength < totalNeeded) {
        break
      }

      const frameBytes = buffer.subarray(LENGTH_PREFIX_BYTES, totalNeeded)
      buffer = buffer.subarray(totalNeeded)

      try {
        const decoded = decode(frameBytes) as Record<string, unknown>
        this.onFrame({
          frameType: decoded.frameType as number,
          requestId: decoded.requestId as string,
          data: new Uint8Array(decoded.data as ArrayLike<number>),
        })
      } catch (err) {
        this.chunks = []
        this.totalLength = 0
        throw new TransportError(
          TransportErrorCodes.DECODE_FAILED,
          `Failed to decode frame: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    this.chunks = buffer.byteLength > 0 ? [buffer] : []
    this.totalLength = buffer.byteLength
  }

  reset(): void {
    this.chunks = []
    this.totalLength = 0
  }

  private compact(): Uint8Array {
    if (this.chunks.length === 0) {
      return new Uint8Array(0)
    }
    if (this.chunks.length === 1) {
      return this.chunks[0]
    }
    const combined = new Uint8Array(this.totalLength)
    let offset = 0
    for (const chunk of this.chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }
    this.chunks = [combined]
    return combined
  }
}
