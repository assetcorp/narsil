import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../errors'
import { isRecord } from '../../payload-guards'
import type { NodeTransport, TransportMessage } from '../../transport/types'
import { TransportError } from '../../transport/types'

export interface RebalanceExchange {
  transport: NodeTransport
  senderId: string
  targets: string[]
  type: string
  payload: unknown
  failureMessage: string
  details: Record<string, unknown>
}

function remoteDetails(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function decodeRebalanceReply(
  response: TransportMessage,
  failureMessage: string,
  details: Record<string, unknown>,
): Record<string, unknown> {
  let decoded: unknown
  try {
    decoded = decode(response.payload)
  } catch (_) {
    decoded = null
  }
  if (!isRecord(decoded)) {
    throw new NarsilError(ErrorCodes.ALLOCATION_FAILED, `${failureMessage}: the answer was unreadable`, details)
  }
  if (response.type.endsWith('.error') || decoded.error === true) {
    throw new NarsilError(
      typeof decoded.code === 'string' ? decoded.code : ErrorCodes.ALLOCATION_FAILED,
      typeof decoded.message === 'string' ? decoded.message : failureMessage,
      { ...remoteDetails(decoded.details), ...details },
    )
  }
  return decoded
}

export async function exchangeRebalanceMessage(exchange: RebalanceExchange): Promise<Record<string, unknown>> {
  const message: TransportMessage = {
    type: exchange.type,
    sourceId: exchange.senderId,
    requestId: generateId(),
    payload: encode(exchange.payload),
  }
  let lastError: unknown = new NarsilError(
    ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
    exchange.failureMessage,
    exchange.details,
  )
  for (const target of exchange.targets) {
    try {
      const response = await exchange.transport.send(target, message)
      return decodeRebalanceReply(response, exchange.failureMessage, exchange.details)
    } catch (error) {
      if (!(error instanceof TransportError)) throw error
      lastError = new NarsilError(ErrorCodes.QUERY_NO_ACTIVE_REPLICA, exchange.failureMessage, {
        ...exchange.details,
        transportCode: error.code,
      })
    }
  }
  throw lastError
}

export function encodeRebalanceRefusal(error: unknown): Uint8Array {
  const code = error instanceof NarsilError ? error.code : ErrorCodes.ALLOCATION_FAILED
  const text = error instanceof Error ? error.message : String(error)
  try {
    return encode({ error: true, code, message: text, details: error instanceof NarsilError ? error.details : {} })
  } catch (_) {
    return encode({ error: true, code, message: text })
  }
}
