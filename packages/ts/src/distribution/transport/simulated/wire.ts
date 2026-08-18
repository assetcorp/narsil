import { decodeTransportMessage, encodeFrame, encodeTransportMessage, FrameParser } from '../tcp/framing'
import { FRAME_TYPE_REQUEST, FRAME_TYPE_STREAM_CHUNK } from '../tcp/types'
import { TransportError, TransportErrorCodes, type TransportMessage } from '../types'

function readOneFrame(frame: Uint8Array): Uint8Array {
  let received: Uint8Array | undefined
  const parser = new FrameParser(parsed => {
    received = parsed.data
  })
  const split = Math.floor(frame.byteLength / 2)
  parser.feed(frame.subarray(0, split))
  parser.feed(frame.subarray(split))
  if (received === undefined) {
    throw new TransportError(TransportErrorCodes.DECODE_FAILED, 'The framed bytes carried no complete frame')
  }
  return received
}

export function encodeMessageFrame(message: TransportMessage): Uint8Array {
  return encodeFrame(FRAME_TYPE_REQUEST, message.requestId, encodeTransportMessage(message))
}

export function decodeMessageFrame(frame: Uint8Array): TransportMessage {
  return decodeTransportMessage(readOneFrame(frame))
}

export function encodeChunkFrame(requestId: string, payload: Uint8Array): Uint8Array {
  return encodeFrame(FRAME_TYPE_STREAM_CHUNK, requestId, payload)
}

export function decodeChunkFrame(frame: Uint8Array): Uint8Array {
  return readOneFrame(frame)
}
