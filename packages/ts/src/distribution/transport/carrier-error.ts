import { CARRIER_ERROR_TEXT_LIMIT_BYTES } from './constants'
import { TransportError, TransportErrorCodes, type TransportMessage } from './types'

const CARRIER_ERROR_TYPE = 'error'

export function carrierFailureOf(message: TransportMessage, target: string): TransportError | null {
  if (message.type !== CARRIER_ERROR_TYPE) return null
  const text = new TextDecoder().decode(message.payload.subarray(0, CARRIER_ERROR_TEXT_LIMIT_BYTES))
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
