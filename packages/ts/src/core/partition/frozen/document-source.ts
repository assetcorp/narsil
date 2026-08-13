import { decode, encode } from '@msgpack/msgpack'
import type { AnyDocument } from '../../../types/schema'

export interface FrozenDocumentSource {
  readonly count: number
  docAt(ordinal: number): AnyDocument
}

export interface EncodedDocumentTableData {
  blob: Uint8Array
  offsets: Uint32Array
}

export function encodeDocumentTableData(documents: ReadonlyArray<AnyDocument>): EncodedDocumentTableData {
  const encoded: Uint8Array[] = new Array(documents.length)
  let blobLength = 0
  for (let ordinal = 0; ordinal < documents.length; ordinal++) {
    const bytes = encode(documents[ordinal])
    encoded[ordinal] = bytes
    blobLength += bytes.length
  }

  const blob = new Uint8Array(blobLength)
  const offsets = new Uint32Array(documents.length + 1)
  let cursor = 0
  for (let ordinal = 0; ordinal < documents.length; ordinal++) {
    blob.set(encoded[ordinal], cursor)
    cursor += encoded[ordinal].length
    offsets[ordinal + 1] = cursor
  }

  return { blob, offsets }
}

export function wrapEncodedDocumentTable(data: EncodedDocumentTableData): FrozenDocumentSource {
  const { blob, offsets } = data
  const count = offsets.length - 1
  const decoded: Array<AnyDocument | undefined> = new Array(count)

  return {
    count,
    docAt(ordinal: number): AnyDocument {
      let document = decoded[ordinal]
      if (document === undefined) {
        document = decode(blob.slice(offsets[ordinal], offsets[ordinal + 1])) as AnyDocument
        decoded[ordinal] = document
      }
      return document
    },
  }
}

export function wrapDocumentArray(documents: ReadonlyArray<AnyDocument>): FrozenDocumentSource {
  return {
    count: documents.length,
    docAt(ordinal: number): AnyDocument {
      return documents[ordinal]
    },
  }
}
