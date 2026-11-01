import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { encodeDocument } from '../../../serialization/document-encoding'
import { encodePathSegments, readEncodedPath } from '../../../serialization/msgpack-path'
import type { AnyDocument } from '../../../types/schema'
import { documentValueBytes, documentWithOwnBuffers, valueWithOwnBuffers } from '../../document-store'
import {
  cloneProjected,
  type ProjectedPathRead,
  projectIncludedPaths,
  type ResolvedProjection,
  readProjectedPath,
} from '../../projection'
import { getNestedValue } from '../utils'

export interface FrozenDocumentSource {
  readonly count: number
  readonly byteLength: number
  docAt(ordinal: number): AnyDocument
  readAt(ordinal: number): AnyDocument
  fieldReader(fieldPath: string): (ordinal: number) => unknown
  projectedAt(ordinal: number, projection?: ResolvedProjection): AnyDocument
}

const encodedProjectionPaths = new WeakMap<readonly string[], Uint8Array[] | null>()

function encodedProjectionPathOf(path: readonly string[]): Uint8Array[] | null {
  let segments = encodedProjectionPaths.get(path)
  if (segments === undefined) {
    segments = encodePathSegments(path)
    encodedProjectionPaths.set(path, segments)
  }
  return segments
}

function sharesPrefix(left: readonly string[], right: readonly string[]): boolean {
  const shared = Math.min(left.length, right.length)
  for (let at = 0; at < shared; at++) {
    if (left[at] !== right[at]) return false
  }
  return true
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
 * Reads documents from an encoded table, decoding a fresh copy on every read
 * so that the table holds nothing beyond its encoded bytes.
 *
 * @param data - The encoded documents and their offsets.
 * @returns A source whose `byteLength` counts the encoded table and its
 * offsets.
 */
export function wrapEncodedDocumentTable(data: EncodedDocumentTableData): FrozenDocumentSource {
  const { blob, offsets } = data
  return createEncodedDocumentSource(
    offsets.length - 1,
    blob.byteLength + offsets.byteLength,
    ordinal => blob.subarray(offsets[ordinal], offsets[ordinal + 1]),
    data.discardedFields,
  )
}

export function createEncodedDocumentSource(
  count: number,
  byteLength: number,
  bytesAt: (ordinal: number) => Uint8Array,
  discardedFields: readonly string[] | undefined,
): FrozenDocumentSource {
  const discarded = (discardedFields ?? []).map(fieldPath => fieldPath.split('.'))
  const touchesDiscarded = (path: readonly string[]): boolean =>
    discarded.some(discardedPath => sharesPrefix(discardedPath, path))
  const docAt = (ordinal: number): AnyDocument =>
    documentWithOwnBuffers(decodeStoredDocument(bytesAt(ordinal), discardedFields))

  function projectedPathAt(ordinal: number, path: string[]): ProjectedPathRead {
    const segments = encodedProjectionPathOf(path)
    if (segments === null) return { found: false, value: undefined }
    const read = touchesDiscarded(path) ? null : readEncodedPath(bytesAt(ordinal), segments, 'missing')
    if (read === null) return readProjectedPath(docAt(ordinal) as Record<string, unknown>, path)
    return read.found ? { found: true, value: valueWithOwnBuffers(read.value) } : read
  }

  return {
    count,
    byteLength,
    docAt,
    readAt(ordinal: number): AnyDocument {
      return decodeStoredDocument(bytesAt(ordinal), discardedFields)
    },
    fieldReader(fieldPath: string): (ordinal: number) => unknown {
      const path = fieldPath.split('.')
      const segments = encodePathSegments(path)
      if (segments === null) return () => undefined
      const decodesDocument = touchesDiscarded(path)
      return ordinal => {
        const read = decodesDocument ? null : readEncodedPath(bytesAt(ordinal), segments, 'decode-document')
        if (read !== null) return valueWithOwnBuffers(read.value)
        return getNestedValue(docAt(ordinal) as Record<string, unknown>, fieldPath)
      }
    },
    projectedAt(ordinal: number, projection?: ResolvedProjection): AnyDocument {
      if (projection === undefined || projection.kind === 'full') return docAt(ordinal)
      if (projection.kind === 'none') return {}
      if (projection.include === null) return cloneProjected(docAt(ordinal) as Record<string, unknown>, projection)
      return projectIncludedPaths(projection.include, projection.exclude, path => projectedPathAt(ordinal, path))
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
    fieldReader(fieldPath: string): (ordinal: number) => unknown {
      return ordinal => getNestedValue(documents[ordinal] as Record<string, unknown>, fieldPath)
    },
    projectedAt(ordinal: number, projection?: ResolvedProjection): AnyDocument {
      return cloneProjected(documents[ordinal] as Record<string, unknown>, projection)
    },
  }
}
