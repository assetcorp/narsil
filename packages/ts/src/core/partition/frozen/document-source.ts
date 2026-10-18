import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { encodeDocument } from '../../../serialization/document-encoding'
import type { AnyDocument } from '../../../types/schema'
import { documentValueBytes } from '../../document-store'

export interface FrozenDocumentSource {
  readonly count: number
  readonly byteLength: number
  docAt(ordinal: number): AnyDocument
  readAt(ordinal: number): AnyDocument
}

export interface EncodedDocumentTableData {
  blob: Uint8Array
  offsets: Uint32Array
  discardedFields?: readonly string[]
}

function removeFieldAtPath(document: Record<string, unknown>, fieldPath: string): void {
  const segments = fieldPath.split('.')
  let current: Record<string, unknown> = document
  for (let i = 0; i < segments.length - 1; i += 1) {
    const next = current[segments[i]]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return
    current = next as Record<string, unknown>
  }
  delete current[segments[segments.length - 1]]
}

export function decodeStoredDocument(bytes: Uint8Array, discardedFields: readonly string[] | undefined): AnyDocument {
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch (error) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `A stored document is not MessagePack: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded) || decoded instanceof Uint8Array) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'A stored document decodes to something other than a map')
  }
  const document = decoded as Record<string, unknown>
  if (discardedFields !== undefined) {
    for (const fieldPath of discardedFields) removeFieldAtPath(document, fieldPath)
  }
  return document as AnyDocument
}

export function* storedDocumentsOf(data: EncodedDocumentTableData): Generator<AnyDocument> {
  const count = data.offsets.length - 1
  for (let ordinal = 0; ordinal < count; ordinal++) {
    yield decodeStoredDocument(
      data.blob.subarray(data.offsets[ordinal], data.offsets[ordinal + 1]),
      data.discardedFields,
    )
  }
}

export function decodeEveryStoredDocument(data: EncodedDocumentTableData): void {
  const count = data.offsets.length - 1
  for (let ordinal = 0; ordinal < count; ordinal++) {
    decodeStoredDocument(data.blob.subarray(data.offsets[ordinal], data.offsets[ordinal + 1]), data.discardedFields)
  }
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
    const bytes = encodeDocument(documents[ordinal])
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
        document = decodeStoredDocument(blob.slice(offsets[ordinal], offsets[ordinal + 1]), data.discardedFields)
        decoded[ordinal] = document
        decodedBytes += documentValueBytes(document)
      }
      return document
    },
    readAt(ordinal: number): AnyDocument {
      return (
        decoded[ordinal] ??
        decodeStoredDocument(blob.subarray(offsets[ordinal], offsets[ordinal + 1]), data.discardedFields)
      )
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
    readAt(ordinal: number): AnyDocument {
      return documents[ordinal]
    },
  }
}
