import { decode, encode } from '@msgpack/msgpack'
import type { AnyDocument } from '../../../types/schema'
import { documentValueBytes } from '../../document-store'

export interface FrozenDocumentSource {
  readonly count: number
  readonly byteLength: number
  docAt(ordinal: number): AnyDocument
}

export interface EncodedDocumentTableData {
  blob: Uint8Array
  offsets: Uint32Array
}

/**
 * Packs documents into one MessagePack blob with an offset table, so a worker
 * can receive them in a single transferable buffer.
 *
 * @param documents - The documents in ordinal order.
 * @returns The concatenated encoded documents and the start offset of each one.
 */
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

/**
 * Reads documents from an encoded table, decoding each one on its first read
 * and keeping the decoded copy for later reads.
 *
 * @param data - The encoded documents and their offsets.
 * @returns A source whose `byteLength` counts the encoded table plus every
 * decoded copy it holds.
 */
export function wrapEncodedDocumentTable(data: EncodedDocumentTableData): FrozenDocumentSource {
  const { blob, offsets } = data
  const count = offsets.length - 1
  const decoded: Array<AnyDocument | undefined> = new Array(count)
  const encodedBytes = blob.byteLength + offsets.byteLength
  let decodedBytes = 0

  return {
    count,
    get byteLength(): number {
      return encodedBytes + decodedBytes
    },
    docAt(ordinal: number): AnyDocument {
      let document = decoded[ordinal]
      if (document === undefined) {
        document = decode(blob.slice(offsets[ordinal], offsets[ordinal + 1])) as AnyDocument
        decoded[ordinal] = document
        decodedBytes += documentValueBytes(document)
      }
      return document
    },
  }
}

/**
 * Reads documents from an in-memory array, which a segment built in this
 * process holds.
 *
 * @param documents - The documents in ordinal order.
 * @returns A source whose `byteLength` estimates the resident size of every
 * document.
 */
export function wrapDocumentArray(documents: ReadonlyArray<AnyDocument>): FrozenDocumentSource {
  let residentBytes = 0
  for (const document of documents) {
    residentBytes += documentValueBytes(document)
  }
  return {
    count: documents.length,
    byteLength: residentBytes,
    docAt(ordinal: number): AnyDocument {
      return documents[ordinal]
    },
  }
}
