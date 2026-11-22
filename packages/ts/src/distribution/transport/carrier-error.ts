import { CARRIER_ERROR_TEXT_LIMIT_BYTES } from './constants'
import { TransportError, TransportErrorCodes, type TransportMessage } from './types'

const CARRIER_ERROR_TYPE = 'error'
const UTF8_CONTINUATION_MASK = 0b1100_0000
const UTF8_CONTINUATION_BITS = 0b1000_0000

function carrierErrorText(payload: Uint8Array): string {
  let end = Math.min(payload.byteLength, CARRIER_ERROR_TEXT_LIMIT_BYTES)
  while (end > 0 && end < payload.byteLength && (payload[end] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS) {
    end -= 1
  }
  return new TextDecoder().decode(payload.subarray(0, end))
}

export function carrierFailureOf(message: TransportMessage, target: string): TransportError | null {
  if (message.type !== CARRIER_ERROR_TYPE) return null
  const text = carrierErrorText(message.payload)
  return new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, `The listener on '${target}' failed: ${text}`, {
    target,
    requestId: message.requestId,
  })
}

export function refuseCarrierFailure(message: TransportMessage, target: string): TransportMessage {
  const failure = carrierFailureOf(message, target)
  if (failure !== null) throw failure
  return message
}
