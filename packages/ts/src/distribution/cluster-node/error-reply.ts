import { encode } from '@msgpack/msgpack'
import { NarsilError } from '../../errors'
import type { AbandonedWrite } from '../transport/types'

export function transportableDetails(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof NarsilError)) {
    return undefined
  }
  try {
    encode(error.details)
    return error.details
  } catch {
    return undefined
  }
}

export function encodeErrorReply(
  code: string,
  message: string,
  details: Record<string, unknown> | undefined,
  abandonedWrite?: AbandonedWrite,
): Uint8Array {
  const reply =
    abandonedWrite === undefined ? { error: true, code, message } : { error: true, code, message, abandonedWrite }
  if (details !== undefined) {
    try {
      return encode({ ...reply, details })
    } catch {
      return encode(reply)
    }
  }
  return encode(reply)
}

export function encodeErrorReplyFrom(
  error: unknown,
  fallbackCode: string,
  abandonedWrite?: AbandonedWrite,
): Uint8Array {
  return encodeErrorReply(
    error instanceof NarsilError ? error.code : fallbackCode,
    error instanceof Error ? error.message : String(error),
    error instanceof NarsilError ? error.details : undefined,
    abandonedWrite,
  )
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function remoteErrorDetails(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {}
}
