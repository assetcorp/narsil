import { Encoder, encode } from '@msgpack/msgpack'
import {
  DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES,
  DOCUMENT_REPLY_ENVELOPE_DEPTH,
  ErrorCodes,
  MAX_DOCUMENT_ENCODING_DEPTH,
  NarsilError,
} from '#platform/msgpack-host'

let integerEncoder: Encoder | undefined
let floatEncoder: Encoder | undefined

function encodeExactly(document: unknown, forceIntegerToFloat: boolean): Uint8Array {
  let encoder: Encoder
  if (forceIntegerToFloat) {
    floatEncoder ??= new Encoder({ maxDepth: MAX_DOCUMENT_ENCODING_DEPTH, forceIntegerToFloat: true })
    encoder = floatEncoder
  } else {
    integerEncoder ??= new Encoder({ maxDepth: MAX_DOCUMENT_ENCODING_DEPTH })
    encoder = integerEncoder
  }
  const bytes = encoder.encode(document)
  if (bytes.byteLength > DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES) {
    if (forceIntegerToFloat) floatEncoder = undefined
    else integerEncoder = undefined
  }
  return bytes
}

function holdsNegativeZero(value: unknown, depth: number): boolean {
  if (typeof value === 'number') return Object.is(value, -0)
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value) || depth > MAX_DOCUMENT_ENCODING_DEPTH) {
    return false
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (holdsNegativeZero(child, depth + 1)) return true
  }
  return false
}

export function encodeDocumentReply(payload: unknown): Uint8Array {
  return encode(payload, { forceIntegerToFloat: holdsNegativeZero(payload, 1 - DOCUMENT_REPLY_ENVELOPE_DEPTH) })
}

export function encodeDocument(document: unknown): Uint8Array {
  try {
    return encodeExactly(document, holdsNegativeZero(document, 1))
  } catch (error) {
    throw new NarsilError(
      ErrorCodes.DOC_VALIDATION_FAILED,
      `The document cannot be encoded as MessagePack: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
