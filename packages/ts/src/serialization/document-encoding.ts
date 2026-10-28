import { Encoder } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../errors'
import { DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES, MAX_DOCUMENT_ENCODING_DEPTH } from './constants'

const INTEGER_ENCODING = { maxDepth: MAX_DOCUMENT_ENCODING_DEPTH }
const FLOAT_ENCODING = { maxDepth: MAX_DOCUMENT_ENCODING_DEPTH, forceIntegerToFloat: true }

let integerEncoder = new Encoder(INTEGER_ENCODING)
let floatEncoder = new Encoder(FLOAT_ENCODING)

function encodeExactly(document: unknown, forceIntegerToFloat: boolean): Uint8Array {
  const bytes = (forceIntegerToFloat ? floatEncoder : integerEncoder).encode(document)
  if (bytes.byteLength > DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES) {
    if (forceIntegerToFloat) floatEncoder = new Encoder(FLOAT_ENCODING)
    else integerEncoder = new Encoder(INTEGER_ENCODING)
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
