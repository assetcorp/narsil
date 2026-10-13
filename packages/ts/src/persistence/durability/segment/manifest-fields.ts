import { ErrorCodes, NarsilError } from '../../../errors'
import { MAX_FILE_BYTES } from '../../../serialization/constants'
import { HEADER_SIZE } from '../../../serialization/header'
import { type FileRef, MAX_SEGMENT_ID } from './manifest'

export function invalidManifest(message: string, details?: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Segment manifest ${message}`, details)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array)
}

export function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SEGMENT_ID
}

export function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
}

export function isSequenceNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function readFileRef(raw: Record<string, unknown>, expectedKey: string, what: string): FileRef {
  if (raw.key !== expectedKey) {
    invalidManifest(`lists the ${what} under the key "${String(raw.key)}" where it belongs at "${expectedKey}"`, {
      key: raw.key,
      expected: expectedKey,
    })
  }
  const bytes = raw.bytes
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < HEADER_SIZE || bytes > MAX_FILE_BYTES) {
    invalidManifest(`gives the ${what} "${expectedKey}" an invalid length`, { key: expectedKey, bytes })
  }
  if (!isUint32(raw.checksum)) invalidManifest(`gives the ${what} "${expectedKey}" an invalid checksum`)
  return { key: expectedKey, bytes, checksum: raw.checksum }
}
