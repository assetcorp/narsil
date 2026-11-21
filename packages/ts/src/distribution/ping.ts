import { encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../errors'
import { encodeErrorReplyFrom } from './cluster-node/error-reply'
import { isRecord, isValidInteger } from './payload-guards'
import { decodeRequestPayload } from './request-decode'
import { ClusterMessageTypes, type PongPayload, type RespondFn, type TransportMessage } from './transport/types'

function readPingTimestamp(payload: Uint8Array): number {
  const decoded = decodeRequestPayload(payload, ClusterMessageTypes.PING)
  if (!isRecord(decoded) || !isValidInteger(decoded.timestamp) || decoded.timestamp < 0) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Invalid PingPayload: it needs a timestamp that is a non-negative integer',
    )
  }
  return decoded.timestamp
}

function pongReply(message: TransportMessage): Pick<TransportMessage, 'type' | 'payload'> {
  try {
    const pong: PongPayload = { timestamp: readPingTimestamp(message.payload), respondedAt: Date.now() }
    return { type: ClusterMessageTypes.PONG, payload: encode(pong) }
  } catch (error) {
    return { type: `${message.type}.error`, payload: encodeErrorReplyFrom(error, ErrorCodes.CONFIG_INVALID) }
  }
}

export function answerPing(message: TransportMessage, respond: RespondFn, nodeId: string): Promise<void> {
  return respond({ ...pongReply(message), sourceId: nodeId, requestId: message.requestId })
}
