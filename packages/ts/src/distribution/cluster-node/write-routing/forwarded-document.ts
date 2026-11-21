import { ErrorCodes, NarsilError } from '../../../errors'
import { decode } from '../../../serialization/msgpack'
import type { AnyDocument } from '../../../types/schema'
import { isRecord } from '../../payload-guards'

export function decodeForwardedDocument(bytes: Uint8Array, documentId: string): AnyDocument {
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch (err) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Forwarded document could not be decoded: ${String(err)}`, {
      documentId,
    })
  }
  if (!isRecord(decoded)) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'A forwarded document must be a MessagePack map', {
      documentId,
    })
  }
  return decoded as AnyDocument
}
