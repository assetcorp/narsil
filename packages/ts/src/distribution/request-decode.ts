import { NarsilError } from '../errors'
import { decode } from '../serialization/msgpack'
import { TransportErrorCodes } from './transport/types'

export function decodeRequestPayload(payload: Uint8Array, messageType: string): unknown {
  try {
    return decode(payload)
  } catch (error) {
    throw new NarsilError(
      TransportErrorCodes.DECODE_FAILED,
      `The payload of a ${messageType} request is not valid MessagePack`,
      { messageType, cause: error instanceof Error ? error.message : String(error) },
    )
  }
}
