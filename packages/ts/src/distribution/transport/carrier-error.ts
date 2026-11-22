import { TransportError, TransportErrorCodes, type TransportMessage } from './types'

const CARRIER_ERROR_TYPE = 'error'

export function carrierFailureOf(message: TransportMessage, target: string): TransportError | null {
  if (message.type !== CARRIER_ERROR_TYPE) return null
  return new TransportError(
    TransportErrorCodes.PEER_UNAVAILABLE,
    `The listener on '${target}' failed: ${new TextDecoder().decode(message.payload)}`,
    { target, requestId: message.requestId },
  )
}

export function refuseCarrierFailure(message: TransportMessage, target: string): TransportMessage {
  const failure = carrierFailureOf(message, target)
  if (failure !== null) throw failure
  return message
}
