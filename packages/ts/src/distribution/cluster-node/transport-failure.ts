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

export async function sendUntilMaybeDelivered<T>(
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
      if (!(error instanceof TransportError && error.code === TransportErrorCodes.CONNECT_FAILED)) break
    }
  }
  if (lastError instanceof TransportError) {
    throw narsilErrorFromTransportFailure(lastError, failure.message, failure.details ?? {})
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function forwardFailedWith(error: unknown, transportCode: TransportErrorCode): boolean {
  return (
    error instanceof NarsilError &&
    error.details.transportCode === transportCode &&
    typeof error.details.targetNodeId === 'string'
  )
}

export function forwardUnsent(error: unknown): boolean {
  if (error instanceof NarsilError && error.code === ErrorCodes.NODE_NOT_READY) return true
  return forwardFailedWith(error, TransportErrorCodes.CONNECT_FAILED)
}

export function forwardInterrupted(error: unknown): boolean {
  return forwardFailedWith(error, TransportErrorCodes.PEER_UNAVAILABLE)
}

export function unsentAfter(error: NarsilError): NarsilError {
  return new NarsilError(error.code, error.message, {
    ...error.details,
    transportCode: TransportErrorCodes.CONNECT_FAILED,
  })
}
