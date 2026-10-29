import { ErrorCodes, NarsilError } from '../../errors'
import { TransportError, type TransportErrorCode, TransportErrorCodes } from '../transport/types'

const FAILURE_CODE_BY_TRANSPORT_CODE: Record<TransportErrorCode, string> = {
  [TransportErrorCodes.CONNECT_FAILED]: ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
  [TransportErrorCodes.PEER_UNAVAILABLE]: ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
  [TransportErrorCodes.TIMEOUT]: ErrorCodes.QUERY_NODE_TIMEOUT,
  [TransportErrorCodes.MESSAGE_TOO_LARGE]: ErrorCodes.QUERY_ROUTING_FAILED,
  [TransportErrorCodes.DECODE_FAILED]: ErrorCodes.QUERY_ROUTING_FAILED,
}

export interface SendFailureContext {
  message: string
  details?: Record<string, unknown>
}

export function narsilErrorFromTransportFailure(
  error: TransportError,
  message: string,
  details: Record<string, unknown>,
): NarsilError {
  return new NarsilError(FAILURE_CODE_BY_TRANSPORT_CODE[error.code], message, {
    ...details,
    transportCode: error.code,
  })
}

export async function sendThroughTargets<T>(
  targets: string[],
  send: (target: string) => Promise<T>,
  failure: SendFailureContext,
): Promise<T> {
  let lastError: unknown
  for (const target of targets) {
    try {
      return await send(target)
    } catch (error) {
      lastError = error
    }
  }
  if (lastError instanceof TransportError) {
    throw narsilErrorFromTransportFailure(lastError, failure.message, failure.details ?? {})
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

const UNDELIVERED_CODES: ReadonlySet<unknown> = new Set([
  TransportErrorCodes.CONNECT_FAILED,
  TransportErrorCodes.PEER_UNAVAILABLE,
])

export function forwardUndelivered(error: unknown): boolean {
  return (
    error instanceof NarsilError &&
    UNDELIVERED_CODES.has(error.details.transportCode) &&
    typeof error.details.targetNodeId === 'string'
  )
}
