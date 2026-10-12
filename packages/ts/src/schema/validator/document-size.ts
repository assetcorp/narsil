import { encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_NESTING_DEPTH } from '../constants'

const LARGEST_HEADER_BYTES = 5
const LARGEST_NUMBER_BYTES = 9
const LARGEST_TIMESTAMP_BYTES = 15
const LARGEST_UTF8_BYTES_PER_UNIT = 3

function upperBoundBytes(value: unknown, budget: number, depth: number): number {
  if (value === null || value === undefined || typeof value === 'boolean') return 1
  if (typeof value === 'number') return LARGEST_NUMBER_BYTES
  if (typeof value === 'string') return LARGEST_HEADER_BYTES + value.length * LARGEST_UTF8_BYTES_PER_UNIT
  if (value instanceof Date) return LARGEST_TIMESTAMP_BYTES
  if (ArrayBuffer.isView(value)) return LARGEST_HEADER_BYTES + value.byteLength
  if (typeof value !== 'object' || depth > MAX_DOCUMENT_NESTING_DEPTH) return LARGEST_NUMBER_BYTES
  let total = LARGEST_HEADER_BYTES
  if (Array.isArray(value)) {
    for (const item of value) {
      total += upperBoundBytes(item, budget - total, depth + 1)
      if (total > budget) return total
    }
    return total
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    total += LARGEST_HEADER_BYTES + key.length * LARGEST_UTF8_BYTES_PER_UNIT
    total += upperBoundBytes(record[key], budget - total, depth + 1)
    if (total > budget) return total
  }
  return total
}

export function messagePackUpperBoundBytes(value: unknown): number {
  return upperBoundBytes(value, Number.POSITIVE_INFINITY, 0)
}

function encodedBytesOf(document: Record<string, unknown>): number | null {
  try {
    return encode(document).byteLength
  } catch {
    return null
  }
}

export function requireDocumentWithinSizeLimit(document: Record<string, unknown>): void {
  if (upperBoundBytes(document, MAX_DOCUMENT_BYTES, 0) <= MAX_DOCUMENT_BYTES) return
  const encodedBytes = encodedBytesOf(document)
  if (encodedBytes === null || encodedBytes <= MAX_DOCUMENT_BYTES) return
  throw new NarsilError(
    ErrorCodes.DOC_VALIDATION_FAILED,
    `The document takes ${encodedBytes} bytes as MessagePack, vector values included, but a document may take at most ${MAX_DOCUMENT_BYTES}`,
    { bytes: encodedBytes, maximum: MAX_DOCUMENT_BYTES },
  )
}
